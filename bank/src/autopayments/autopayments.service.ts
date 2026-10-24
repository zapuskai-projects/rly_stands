import type { Pool } from 'pg';
import type { Kopecks } from '../accounts/money';
import type { BankClock } from '../clock/bank-clock';
import { moscowDateKey } from '../clock/moscow';
import { lockClientForTransfers } from '../clients/clients.repository';
import { withTransaction, type Db } from '../db/pool';
import { badRequest, conflict, notFound, unprocessable } from '../shared/errors';
import { resolveAmount } from '../templates/template-rules';
import { findClientTemplate } from '../templates/templates.repository';
import {
  findClientAutopayment,
  insertAutopayment,
  listExpiredAutopaymentIds,
  lockAutopayment,
  maxRunSeries,
  setAutopaymentState,
  type AutopaymentRecord,
} from './autopayments.repository';
import { firstRunDate, isValidDateKey } from './schedule';

export interface AutopaymentDeps {
  pool: Pool;
  clock: BankClock;
}

export interface NewAutopaymentInput {
  templateId: string;
  dayOfMonth: number;
  amount?: Kopecks;
  endsOn?: string;
}

function invalidDate(message: string): never {
  throw badRequest('VALIDATION_ERROR', 'Запрос не прошёл проверку формата', [{ field: 'body.endsOn', message }]);
}

export async function createAutopayment(deps: AutopaymentDeps, clientId: string, input: NewAutopaymentInput): Promise<AutopaymentRecord> {
  if (input.endsOn !== undefined && !isValidDateKey(input.endsOn)) invalidDate('Дата окончания — настоящая дата вида 2026-12-31');
  return withTransaction(deps.pool, async (tx) => {
    await lockClientForTransfers(tx, clientId);
    const template = await findClientTemplate(tx, clientId, input.templateId);
    if (!template) throw notFound('TEMPLATE_NOT_FOUND', 'Шаблон не найден');
    const amount = resolveAmount(template.amount, input.amount);
    if (amount === null) throw unprocessable('AMOUNT_REQUIRED', 'У шаблона нет суммы: укажите её в запросе');
    const now = deps.clock.now();
    const nextRunOn = firstRunDate(now, input.dayOfMonth);
    if (input.endsOn !== undefined && input.endsOn < nextRunOn) invalidDate(`Дата окончания раньше первого платежа ${nextRunOn}`);
    const id = await insertAutopayment(tx, {
      clientId,
      templateId: template.id,
      dayOfMonth: input.dayOfMonth,
      amount,
      endsOn: input.endsOn ?? null,
      nextRunOn,
      at: now,
    });
    return (await findClientAutopayment(tx, clientId, id)) as AutopaymentRecord;
  });
}

async function requireOwned(tx: Db, clientId: string, id: string): Promise<AutopaymentRecord> {
  const owned = await findClientAutopayment(tx, clientId, id);
  const locked = owned ? await lockAutopayment(tx, id) : null;
  if (!locked) throw notFound('AUTOPAYMENT_NOT_FOUND', 'Автоплатёж не найден');
  return locked;
}

function requireStatus(autopayment: AutopaymentRecord, allowed: readonly AutopaymentRecord['status'][], message: string): void {
  if (!allowed.includes(autopayment.status)) throw conflict('AUTOPAYMENT_STATE_INVALID', message);
}

export async function pauseAutopayment(deps: AutopaymentDeps, clientId: string, id: string): Promise<AutopaymentRecord> {
  return withTransaction(deps.pool, async (tx) => {
    const current = await requireOwned(tx, clientId, id);
    requireStatus(current, ['ACTIVE'], 'Поставить на паузу можно только действующий автоплатёж');
    await setAutopaymentState(tx, id, { status: 'PAUSED' }, deps.clock.now());
    return (await findClientAutopayment(tx, clientId, id)) as AutopaymentRecord;
  });
}

export async function resumeAutopayment(deps: AutopaymentDeps, clientId: string, id: string): Promise<AutopaymentRecord> {
  return withTransaction(deps.pool, async (tx) => {
    const current = await requireOwned(tx, clientId, id);
    requireStatus(current, ['PAUSED', 'FAILED'], 'Возобновить можно автоплатёж на паузе или остановленный из-за ошибки');
    const now = deps.clock.now();
    const nextRunOn = firstRunDate(now, current.dayOfMonth);
    if (current.endsOn !== null && nextRunOn > current.endsOn) throw conflict('AUTOPAYMENT_STATE_INVALID', 'Следующий платёж позже даты окончания автоплатежа');
    const series = (await maxRunSeries(tx, id, nextRunOn)) + 1;
    await setAutopaymentState(tx, id, { status: 'ACTIVE', cycleOn: nextRunOn, nextRunOn, attempt: 0, series, failureCode: null }, now);
    return (await findClientAutopayment(tx, clientId, id)) as AutopaymentRecord;
  });
}

export async function cancelAutopayment(deps: AutopaymentDeps, clientId: string, id: string): Promise<AutopaymentRecord> {
  return withTransaction(deps.pool, async (tx) => {
    const current = await requireOwned(tx, clientId, id);
    requireStatus(current, ['ACTIVE', 'PAUSED', 'FAILED'], 'Автоплатёж уже завершён');
    await setAutopaymentState(tx, id, { status: 'FINISHED', nextRunOn: null }, deps.clock.now());
    return (await findClientAutopayment(tx, clientId, id)) as AutopaymentRecord;
  });
}

export async function finishExpiredAutopayments(deps: AutopaymentDeps): Promise<number> {
  const now = deps.clock.now();
  const ids = await listExpiredAutopaymentIds(deps.pool, moscowDateKey(now));
  for (const id of ids) {
    await withTransaction(deps.pool, async (tx) => {
      const current = await lockAutopayment(tx, id);
      if (current && current.status !== 'FINISHED') await setAutopaymentState(tx, id, { status: 'FINISHED', nextRunOn: null }, now);
    });
  }
  return ids.length;
}
