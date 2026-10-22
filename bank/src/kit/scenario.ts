import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import { withTransaction, type Db } from '../db/pool';
import { saveActiveDefects } from '../defects/defects.repository';
import { setDailyLimitOverride } from '../office/clients.repository';
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

async function applyPersona(db: Db, persona: PersonaPatchInput): Promise<void> {
  const client = await db.query<{ id: string }>('SELECT id FROM clients WHERE phone = $1', [persona.phone]);
  const clientId = (client.rows[0] as { id: string }).id;
  if (persona.tariffCode) await db.query('UPDATE clients SET tariff_code = $2 WHERE id = $1', [clientId, persona.tariffCode]);
  if (persona.dailyLimitKop !== undefined) await setDailyLimitOverride(db, clientId, persona.dailyLimitKop === null ? null : BigInt(persona.dailyLimitKop));
  if (persona.accountStatus) {
    await db.query('UPDATE accounts SET status = $2 WHERE client_id = $1 AND is_primary', [clientId, persona.accountStatus]);
  }
}

export async function applyScenario(deps: KitScenarioDeps, scenario: ScenarioInput): Promise<void> {
  await checkReferences(deps.pool, scenario);
  await withTransaction(deps.pool, async (tx) => {
    await tx.query('UPDATE scenario SET label = $1, sbp_mode = $2, updated_at = now() WHERE id = 1', [scenario.label, SBP_MODE[scenario.sbpMode]]);
    await saveActiveDefects(tx, scenario.defects);
    for (const patch of scenario.tariffs ?? []) await applyTariffPatch(tx, patch);
    for (const persona of scenario.personas ?? []) await applyPersona(tx, persona);
  });
  await shiftBankTime(deps.pool, deps.clock, scenario.bankTime);
}
