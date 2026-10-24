import type { Pool } from 'pg';
import { findPrimaryAccount, findSystemAccount } from '../accounts/accounts.repository';
import { postEntries } from '../accounts/ledger';
import type { BankClock } from '../clock/bank-clock';
import { withTransaction, type Db } from '../db/pool';
import { saveActiveDefects } from '../defects/defects.repository';
import { setDailyLimitOverride } from '../office/clients.repository';
import { insertHistoryTransfer } from '../seed/history';
import { shiftBankTime } from '../scenario/bank-time';
import type { SbpMode } from '../scenario/scenario.repository';
import { unprocessable } from '../shared/errors';
import type { PersonaPatchInput, ScenarioInput } from './schemas';
import { applyTariffPatch, findTariffs } from './tariffs';

export interface KitScenarioDeps {
  pool: Pool;
  clock: BankClock;
}

const SBP_MODE: Record<ScenarioInput['sbpMode'], SbpMode> = {
  NORMAL: 'NORMAL',
  REJECT: 'REJECT',
  TIMEOUT: 'TIMEOUT',
  UNAVAILABLE: 'DOWN',
};

async function checkReferences(db: Db, scenario: ScenarioInput): Promise<void> {
  const tariffs = await findTariffs(db);
  const unknownTariff = [...(scenario.tariffs ?? []).map((patch) => patch.code), ...(scenario.personas ?? []).flatMap((persona) => (persona.tariffCode ? [persona.tariffCode] : []))].find(
    (code) => !tariffs.has(code),
  );
  if (unknownTariff) throw unprocessable('UNKNOWN_TARIFF', `Тариф ${unknownTariff} не найден`);
  for (const persona of scenario.personas ?? []) {
    const found = await db.query('SELECT 1 FROM clients WHERE phone = $1', [persona.phone]);
    if (found.rowCount === 0) throw unprocessable('UNKNOWN_PERSONA', `Клиента с телефоном ${persona.phone} нет`);
  }
}

const HISTORY_RECIPIENT = { recipientPhone: '+79000000021', recipientBankCode: 'NORTHWIND', recipientName: 'Иван К.' };

async function fundAndRecord(deps: KitScenarioDeps, db: Db, clientId: string, persona: PersonaPatchInput): Promise<void> {
  const account = await findPrimaryAccount(db, clientId);
  if (!account) throw unprocessable('ACCOUNT_NOT_FOUND', `У клиента ${persona.phone} нет основного счёта`);
  const spent = (persona.history ?? []).reduce((sum, item) => sum + BigInt(item.amountKop), 0n);
  if (account.balance + BigInt(persona.topUpKop ?? 0) < spent) {
    throw unprocessable('INSUFFICIENT_FUNDS_FOR_HISTORY', `У клиента ${persona.phone} не хватает денег на переводы прошлого: добавьте topUpKop`);
  }
  if (persona.topUpKop !== undefined) {
    const opening = await findSystemAccount(db, 'OPENING');
    await postEntries(
      db,
      [{ debitAccountId: opening.id, creditAccountId: account.id, amount: BigInt(persona.topUpKop), kind: 'OPENING', description: 'Пополнение счёта' }],
      { operationId: null, postedAt: deps.clock.now() },
    );
  }
  const correspondent = await findSystemAccount(db, 'CORRESPONDENT');
  for (const item of persona.history ?? []) {
    await insertHistoryTransfer(db, { clientId, accountId: account.id, correspondentId: correspondent.id }, { ...HISTORY_RECIPIENT, at: item.at, amount: BigInt(item.amountKop) });
  }
}

async function applyPersona(deps: KitScenarioDeps, db: Db, persona: PersonaPatchInput): Promise<void> {
  const client = await db.query<{ id: string }>('SELECT id FROM clients WHERE phone = $1', [persona.phone]);
  const clientId = (client.rows[0] as { id: string }).id;
  if (persona.tariffCode) await db.query('UPDATE clients SET tariff_code = $2 WHERE id = $1', [clientId, persona.tariffCode]);
  if (persona.dailyLimitKop !== undefined) await setDailyLimitOverride(db, clientId, persona.dailyLimitKop === null ? null : BigInt(persona.dailyLimitKop));
  if (persona.accountStatus) {
    await db.query('UPDATE accounts SET status = $2 WHERE client_id = $1 AND is_primary', [clientId, persona.accountStatus]);
  }
  if (persona.topUpKop !== undefined || persona.history?.length) await fundAndRecord(deps, db, clientId, persona);
}

export async function applyScenario(deps: KitScenarioDeps, scenario: ScenarioInput): Promise<void> {
  await checkReferences(deps.pool, scenario);
  await withTransaction(deps.pool, async (tx) => {
    await tx.query('UPDATE scenario SET label = $1, sbp_mode = $2, release = $3, updated_at = now() WHERE id = 1', [
      scenario.label,
      SBP_MODE[scenario.sbpMode],
      scenario.release,
    ]);
    await saveActiveDefects(tx, scenario.defects);
    for (const patch of scenario.tariffs ?? []) await applyTariffPatch(tx, patch);
    for (const persona of scenario.personas ?? []) await applyPersona(deps, tx, persona);
  });
  await shiftBankTime(deps.pool, deps.clock, scenario.bankTime);
}
