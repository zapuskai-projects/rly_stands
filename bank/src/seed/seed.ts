import type { Pool } from 'pg';
import { insertAccount, insertCard, type Account, type SystemAccountKind } from '../accounts/accounts.repository';
import { buildAccountNumber } from '../accounts/account-number';
import { buildCardNumber } from '../accounts/card';
import { postEntries } from '../accounts/ledger';
import type { BankClock } from '../clock/bank-clock';
import { insertClient } from '../clients/clients.repository';
import { withTransaction, type Db } from '../db/pool';
import { ensureLavkaPartner } from '../partners/partners.repository';
import { BANK } from '../shared/bank-identity';
import { logger } from '../shared/logger';
import { insertOperator } from '../operators/operators.repository';
import { hashPassword } from '../operators/passwords';
import { seedHistory, historyMoment } from './history';
import { OPERATOR_SEEDS } from './operators';
import { PERSONAS } from './personas';

interface SystemAccountSpec {
  kind: SystemAccountKind;
  balanceAccount: string;
  title: string;
}

const SYSTEM_ACCOUNTS: readonly SystemAccountSpec[] = [
  { kind: 'CORRESPONDENT', balanceAccount: '30101', title: 'Корреспондентский счёт банка' },
  { kind: 'INCOME', balanceAccount: '70601', title: 'Доходы от комиссий за переводы' },
  { kind: 'OPENING', balanceAccount: '99997', title: 'Технический счёт начальных остатков' },
];

async function createSystemAccounts(tx: Db, openedAt: Date): Promise<Map<SystemAccountKind, Account>> {
  const accounts = new Map<SystemAccountKind, Account>();
  for (const spec of SYSTEM_ACCOUNTS) {
    const account = await insertAccount(tx, {
      number: buildAccountNumber(BANK.bik, { balanceAccount: spec.balanceAccount, serial: 1 }),
      clientId: null,
      kind: spec.kind,
      title: spec.title,
      openedAt,
    });
    accounts.set(spec.kind, account);
  }
  return accounts;
}

export async function seedIfEmpty(pool: Pool, clock: BankClock): Promise<boolean> {
  return withTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(87000002)');
    const existing = await tx.query<{ total: bigint }>('SELECT COUNT(*) AS total FROM clients');
    const now = clock.now();
    if ((existing.rows[0] as { total: bigint }).total > 0n) {
      await ensureLavkaPartner(tx, now);
      return false;
    }
    const system = await createSystemAccounts(tx, now);
    const opening = (system.get('OPENING') as Account).id;
    const correspondent = (system.get('CORRESPONDENT') as Account).id;
    for (const operator of OPERATOR_SEEDS) {
      await insertOperator(tx, {
        login: operator.login,
        fullName: operator.fullName,
        shortName: operator.shortName,
        role: operator.role,
        passwordHash: hashPassword(operator.password),
        createdAt: now,
      });
    }
    for (const persona of PERSONAS) {
      const since = new Date(`${persona.customerSince}T09:00:00+03:00`);
      const openingAt = persona.openingDaysAgo === undefined ? now : historyMoment(now, persona.openingDaysAgo, 10, 0);
      const client = await insertClient(tx, {
        number: persona.number,
        fullName: persona.fullName,
        phone: persona.phone,
        kind: persona.kind,
        resident: persona.resident,
        inn: persona.inn,
        tariffCode: persona.tariffCode,
        createdAt: since,
      });
      const accountIds = new Map<number, string>();
      const historyTotal = (persona.history ?? []).reduce((sum, item) => sum + item.amount, 0n);
      for (const spec of persona.accounts) {
        const account = await insertAccount(tx, {
          number: buildAccountNumber(BANK.bik, { balanceAccount: spec.balanceAccount, serial: spec.serial }),
          clientId: client.id,
          kind: spec.kind,
          title: spec.title,
          status: spec.status,
          isPrimary: spec.isPrimary,
          openedAt: since,
        });
        accountIds.set(spec.serial, account.id);
        await postEntries(
          tx,
          [{ debitAccountId: opening, creditAccountId: account.id, amount: spec.isPrimary ? spec.balance + historyTotal : spec.balance, kind: 'OPENING', description: 'Начальный остаток' }],
          { operationId: null, postedAt: openingAt },
        );
      }
      for (const card of persona.cards) {
        await insertCard(tx, {
          number: buildCardNumber(BANK.cardBin, card.serial),
          clientId: client.id,
          accountId: accountIds.get(card.accountSerial) as string,
          product: card.product,
          holderName: persona.fullName,
          expiryMonth: card.expiryMonth,
          expiryYear: card.expiryYear,
        });
      }
      const primary = persona.accounts.find((spec) => spec.isPrimary);
      if (persona.history && primary) {
        await seedHistory(
          tx,
          now,
          { clientId: client.id, accountId: accountIds.get(primary.serial) as string, correspondentId: correspondent },
          persona.history,
        );
      }
    }
    await ensureLavkaPartner(tx, now);
    logger.info('personas seeded', { clients: PERSONAS.length });
    return true;
  });
}
