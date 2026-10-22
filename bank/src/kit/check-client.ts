import type { Pool } from 'pg';
import { findSystemAccount, insertAccount } from '../accounts/accounts.repository';
import { buildAccountNumber } from '../accounts/account-number';
import { postEntries } from '../accounts/ledger';
import type { BankClock } from '../clock/bank-clock';
import { insertClient } from '../clients/clients.repository';
import { withTransaction } from '../db/pool';
import { BANK } from '../shared/bank-identity';
import { badRequest } from '../shared/errors';
import type { CheckClientActionInput } from './schemas';

const TECHNICAL_PHONE_PREFIX = '+7900999';
const TECHNICAL_CLIENT_NAME = 'Проверка набора';
const TECHNICAL_ACCOUNT_SERIAL_BASE = 9_000_000;
const TECHNICAL_LIMIT = 9999;
const CREATE_LOCK_ID = 87_000_004;

export function technicalPhone(index: number): string {
  return `${TECHNICAL_PHONE_PREFIX}${String(index).padStart(4, '0')}`;
}

export function technicalClientNumber(index: number): string {
  return `9${String(index).padStart(7, '0')}`;
}

export function technicalAccountSerial(index: number): number {
  return TECHNICAL_ACCOUNT_SERIAL_BASE + index;
}

export interface CheckClient {
  phone: string;
  accountNumber: string;
}

export async function createCheckClient(deps: { pool: Pool; clock: BankClock }, input: CheckClientActionInput): Promise<CheckClient> {
  return withTransaction(deps.pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [CREATE_LOCK_ID]);
    const tariff = await tx.query('SELECT 1 FROM tariffs WHERE code = $1', [input.tariffCode]);
    if (tariff.rows.length === 0) {
      throw badRequest('VALIDATION_ERROR', 'Запрос не прошёл проверку формата', [{ field: 'tariffCode', message: 'тариф не найден' }]);
    }
    const last = await tx.query<{ last: string | null }>("SELECT MAX(substr(phone, 9)) AS last FROM clients WHERE technical");
    const index = Number(last.rows[0]?.last ?? 0) + 1;
    if (index > TECHNICAL_LIMIT) throw badRequest('VALIDATION_ERROR', 'Технические клиенты закончились: выполните сброс банка', []);
    const now = deps.clock.now();
    const client = await insertClient(tx, {
      number: technicalClientNumber(index),
      fullName: TECHNICAL_CLIENT_NAME,
      phone: technicalPhone(index),
      kind: 'INDIVIDUAL',
      resident: true,
      inn: null,
      tariffCode: input.tariffCode,
      createdAt: now,
      technical: true,
    });
    const account = await insertAccount(tx, {
      number: buildAccountNumber(BANK.bik, { balanceAccount: '40817', serial: technicalAccountSerial(index) }),
      clientId: client.id,
      kind: 'CURRENT',
      title: 'Текущий счёт',
      isPrimary: true,
      openedAt: now,
    });
    if (input.balanceKop > 0) {
      const opening = await findSystemAccount(tx, 'OPENING');
      await postEntries(
        tx,
        [{ debitAccountId: opening.id, creditAccountId: account.id, amount: BigInt(input.balanceKop), kind: 'OPENING', description: 'Начальный остаток' }],
        { operationId: null, postedAt: now },
      );
    }
    return { phone: client.phone, accountNumber: account.number };
  });
}
