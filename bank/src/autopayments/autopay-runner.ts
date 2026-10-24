import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import { moscowDateKey } from '../clock/moscow';
import { findClientById } from '../clients/clients.repository';
import { withTransaction, type Db } from '../db/pool';
import type { DefectMark } from '../defects/catalog';
import { loadActiveDefects } from '../defects/defects.repository';
import { autopaymentExecutedMessage } from '../events/builders';
import { enqueueOutbox } from '../events/outbox.repository';
import { loadContact, queuePair } from '../notifications/queue';
import { findIdempotencyRecord, findOperationOfAnyClient, loadStatusHistories, type OperationRecord } from '../payments/operations.repository';
import { isTerminal } from '../payments/status';
import { createTransfer } from '../payments/transfer.service';
import type { RecipientNameLookup } from '../sbp/gateway';
import { BankError, conflict, notFound } from '../shared/errors';
import { logger } from '../shared/logger';
import { templateCommand } from '../templates/template-rules';
import { findTemplateOfAnyClient } from '../templates/templates.repository';
import { executedTexts, failedTexts, type FailureEnding } from './autopay-texts';
import {
  attachRunOperation,
  finishRun,
  findClientAutopayment,
  findRun,
  hasPendingRun,
  insertRun,
  insertRunMarks,
  lockAutopayment,
  lockPendingRun,
  setAutopaymentState,
  type AutopaymentRecord,
  type AutopaymentState,
  type RunRecord,
} from './autopayments.repository';
import { addDays, decideAfterFailure, isDue, MAX_ATTEMPTS, nextCycleDate, runKey } from './schedule';

export interface RunnerDeps {
  pool: Pool;
  clock: BankClock;
  lookupRecipient?: RecipientNameLookup;
}

export interface RunContext {
  requestId: string;
  attemptLabel: string | null;
}

export type StartMode = 'SCHEDULE' | 'MANUAL';

export async function startAttempt(deps: RunnerDeps, autopaymentId: string, mode: StartMode): Promise<string | null> {
  return withTransaction(deps.pool, async (tx) => {
    const autopayment = await lockAutopayment(tx, autopaymentId);
    if (!autopayment || autopayment.status !== 'ACTIVE' || autopayment.nextRunOn === null) return null;
    if (mode === 'SCHEDULE' && !isDue(deps.clock.now(), autopayment.nextRunOn)) return null;
    if (await hasPendingRun(tx, autopaymentId)) return null;
    const attempt = autopayment.attempt + 1;
    if (attempt > MAX_ATTEMPTS) return null;
    const cycleDate = autopayment.cycleOn ?? autopayment.nextRunOn;
    const runId = await insertRun(tx, {
      autopaymentId,
      runDate: autopayment.nextRunOn,
      cycleDate,
      series: autopayment.series,
      attempt,
      amount: autopayment.amount,
      idempotencyKey: runKey(autopaymentId, cycleDate, attempt, autopayment.series),
      at: deps.clock.now(),
    });
    if (runId === null) {
      logger.error('autopayment run already recorded', { autopaymentId, cycleDate, attempt, series: autopayment.series });
      throw new Error(`Запуск автоплатежа ${autopaymentId} за ${cycleDate}, попытка ${attempt} уже записан: расписание не сдвинулось`);
    }
    return runId;
  });
}

interface Verdict {
  outcome: 'EXECUTED' | 'FAILED';
  reasonCode: string | null;
}

function failureCodeOf(operation: OperationRecord, lastReason: string | null): string {
  return operation.rejectCode ?? lastReason ?? operation.status;
}

interface StateChange {
  state: AutopaymentState;
  retryOn: string | null;
  marks: DefectMark[];
}

function stateAfter(autopayment: AutopaymentRecord, run: RunRecord, verdict: Verdict, now: Date, noRetryOnFunds: boolean): StateChange {
  if (autopayment.status === 'FINISHED') return { state: { nextRunOn: null }, retryOn: null, marks: [] };
  if (verdict.outcome === 'EXECUTED') {
    const nextRunOn = nextCycleDate(autopayment.dayOfMonth, run.cycleDate, now, autopayment.endsOn);
    const next = nextRunOn === null ? { status: 'FINISHED' as const } : { cycleOn: nextRunOn };
    return { state: { attempt: 0, series: 1, failureCode: null, nextRunOn, ...next }, retryOn: null, marks: [] };
  }
  const reason = verdict.reasonCode ?? 'UNKNOWN';
  const retryOn = addDays(moscowDateKey(now), 1);
  const withinEnd = autopayment.endsOn === null || retryOn <= autopayment.endsOn;
  const retry = decideAfterFailure(reason, run.attempt, noRetryOnFunds) === 'RETRY' && withinEnd;
  if (retry) return { state: { attempt: run.attempt, failureCode: reason, nextRunOn: retryOn }, retryOn, marks: [] };
  const skipped = noRetryOnFunds && decideAfterFailure(reason, run.attempt) === 'RETRY' && withinEnd;
  const marks: DefectMark[] = skipped ? [{ code: 'autopay-no-retry', details: { expected: 'RETRY', actual: 'FAILED', reasonCode: reason, attempt: run.attempt } }] : [];
  const stopped = autopayment.status === 'ACTIVE' ? { status: 'FAILED' as const } : {};
  return { state: { attempt: run.attempt, failureCode: reason, nextRunOn: null, ...stopped }, retryOn: null, marks };
}

const ENDING: Record<AutopaymentRecord['status'], FailureEnding> = { ACTIVE: 'STOPPED', FAILED: 'STOPPED', PAUSED: 'PAUSED', FINISHED: 'ENDED' };

async function notifyRun(tx: Db, autopayment: AutopaymentRecord, run: RunRecord, verdict: Verdict, retryOn: string | null, requestId: string, at: Date): Promise<void> {
  const contact = await loadContact(tx, autopayment.clientId);
  if (!contact) return;
  const facts = { name: autopayment.templateName, amount: run.amount };
  const executed = verdict.outcome === 'EXECUTED';
  await queuePair(tx, {
    operationId: run.operationId,
    autopaymentId: autopayment.id,
    requestId,
    contact,
    kind: executed ? 'AUTOPAYMENT_EXECUTED' : 'AUTOPAYMENT_FAILED',
    texts: executed ? executedTexts(facts, run.operationNumber) : failedTexts(facts, verdict.reasonCode, run.attempt, retryOn, ENDING[autopayment.status]),
    at,
  });
}

async function settleRun(deps: RunnerDeps, runId: string, verdict: Verdict, requestId: string): Promise<void> {
  const known = await findRun(deps.pool, runId);
  if (!known) return;
  await withTransaction(deps.pool, async (tx) => {
    const autopayment = await lockAutopayment(tx, known.autopaymentId);
    const run = await lockPendingRun(tx, runId);
    if (!autopayment || !run) return;
    const now = deps.clock.now();
    await finishRun(tx, runId, verdict.outcome, verdict.reasonCode, now);
    const noRetryOnFunds = (await loadActiveDefects(tx)).has('autopay-no-retry');
    const { state, retryOn, marks } = stateAfter(autopayment, run, verdict, now, noRetryOnFunds);
    await setAutopaymentState(tx, autopayment.id, state, now);
    await insertRunMarks(tx, runId, marks, now);
    const client = await findClientById(tx, autopayment.clientId);
    await enqueueOutbox(
      tx,
      autopaymentExecutedMessage({
        autopaymentId: autopayment.id,
        runId,
        clientNumber: client?.number ?? '',
        runDate: run.runDate,
        cycleDate: run.cycleDate,
        attempt: run.attempt,
        outcome: verdict.outcome,
        operationId: run.operationId,
        operationNumber: run.operationNumber,
        reasonCode: verdict.reasonCode,
        amount: run.amount,
        finishedAt: now,
        requestId,
      }),
    );
    await notifyRun(tx, autopayment, run, verdict, retryOn, requestId, now);
  });
}

async function verdictOf(pool: Pool, operation: OperationRecord): Promise<Verdict | null> {
  if (!isTerminal(operation.status)) return null;
  if (operation.status === 'COMPLETED') return { outcome: 'EXECUTED', reasonCode: null };
  const history = (await loadStatusHistories(pool, [operation.id])).get(operation.id) ?? [];
  const lastReason = [...history].reverse().find((item) => item.reasonCode)?.reasonCode ?? null;
  return { outcome: 'FAILED', reasonCode: failureCodeOf(operation, lastReason) };
}

type Creation = { kind: 'CREATED'; operationId: string } | { kind: 'REFUSED'; reasonCode: string };

async function createRunOperation(deps: RunnerDeps, run: RunRecord, context: RunContext): Promise<Creation | null> {
  return withTransaction(deps.pool, async (tx) => {
    const autopayment = await lockAutopayment(tx, run.autopaymentId);
    if (!autopayment) return null;
    if (autopayment.status === 'FINISHED') return { kind: 'REFUSED', reasonCode: 'AUTOPAYMENT_CANCELLED' };
    if (autopayment.status === 'PAUSED') return { kind: 'REFUSED', reasonCode: 'AUTOPAYMENT_PAUSED' };
    const template = await findTemplateOfAnyClient(tx, autopayment.templateId);
    if (!template || template.deletedAt) return { kind: 'REFUSED', reasonCode: 'TEMPLATE_NOT_FOUND' };
    try {
      const created = await createTransfer(deps, {
        clientId: autopayment.clientId,
        idempotencyKey: run.idempotencyKey,
        command: templateCommand(template, run.amount, template.comment),
        templateId: template.id,
        requestId: context.requestId,
        attemptLabel: context.attemptLabel,
      });
      await attachRunOperation(tx, run.id, created.operationId);
      return { kind: 'CREATED', operationId: created.operationId };
    } catch (error) {
      if (!(error instanceof BankError)) throw error;
      const existing = error.code === 'IDEMPOTENCY_KEY_REUSED' ? await findIdempotencyRecord(tx, autopayment.clientId, run.idempotencyKey) : null;
      if (existing) {
        await attachRunOperation(tx, run.id, existing.operationId);
        return { kind: 'CREATED', operationId: existing.operationId };
      }
      return { kind: 'REFUSED', reasonCode: error.code };
    }
  });
}

export async function advanceRun(deps: RunnerDeps, runId: string, context: RunContext): Promise<void> {
  const run = await findRun(deps.pool, runId);
  if (!run || run.outcome !== 'PENDING') return;
  let operationId = run.operationId;
  if (!operationId) {
    const creation = await createRunOperation(deps, run, context);
    if (!creation) return;
    if (creation.kind === 'REFUSED') {
      await settleRun(deps, runId, { outcome: 'FAILED', reasonCode: creation.reasonCode }, context.requestId);
      return;
    }
    operationId = creation.operationId;
  }
  const operation = await findOperationOfAnyClient(deps.pool, operationId);
  const verdict = operation ? await verdictOf(deps.pool, operation) : null;
  if (verdict) await settleRun(deps, runId, verdict, context.requestId);
}

export interface RunNowResult {
  run: RunRecord;
  autopayment: AutopaymentRecord;
}

export async function runAutopaymentNow(deps: RunnerDeps, clientId: string, autopaymentId: string, context: RunContext): Promise<RunNowResult> {
  const current = await findClientAutopayment(deps.pool, clientId, autopaymentId);
  if (!current) throw notFound('AUTOPAYMENT_NOT_FOUND', 'Автоплатёж не найден');
  if (current.status !== 'ACTIVE') throw conflict('AUTOPAYMENT_STATE_INVALID', 'Исполнить можно только действующий автоплатёж');
  const runId = await startAttempt(deps, autopaymentId, 'MANUAL');
  if (!runId) throw conflict('AUTOPAYMENT_STATE_INVALID', 'Предыдущий запуск ещё не завершён');
  await advanceRun(deps, runId, context);
  return {
    run: (await findRun(deps.pool, runId)) as RunRecord,
    autopayment: (await findClientAutopayment(deps.pool, clientId, autopaymentId)) as AutopaymentRecord,
  };
}
