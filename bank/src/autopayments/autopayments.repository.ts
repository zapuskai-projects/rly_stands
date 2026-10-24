import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';
import type { DefectMark } from '../defects/catalog';
import { isTerminal, OPERATION_STATUSES } from '../payments/status';
import type { AutopaymentStatus } from './schedule';

const TERMINAL_STATUSES = OPERATION_STATUSES.filter(isTerminal);

export interface AutopaymentRecord {
  id: string;
  clientId: string;
  templateId: string;
  templateName: string;
  dayOfMonth: number;
  amount: Kopecks;
  endsOn: string | null;
  status: AutopaymentStatus;
  cycleOn: string | null;
  nextRunOn: string | null;
  attempt: number;
  series: number;
  remindedFor: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RunOutcome = 'PENDING' | 'EXECUTED' | 'FAILED';

export interface RunRecord {
  id: string;
  autopaymentId: string;
  runDate: string;
  cycleDate: string;
  series: number;
  attempt: number;
  outcome: RunOutcome;
  operationId: string | null;
  operationNumber: string | null;
  reasonCode: string | null;
  amount: Kopecks;
  idempotencyKey: string;
  startedAt: Date;
  finishedAt: Date | null;
}

interface AutopaymentRow {
  id: string;
  client_id: string;
  template_id: string;
  template_name: string;
  day_of_month: number;
  amount_kop: bigint;
  ends_on: string | null;
  status: AutopaymentStatus;
  cycle_on: string | null;
  next_run_on: string | null;
  attempt: number;
  series: number;
  reminded_for: string | null;
  failure_code: string | null;
  created_at: Date;
  updated_at: Date;
}

interface RunRow {
  id: string;
  autopayment_id: string;
  run_date: string;
  cycle_date: string;
  series: number;
  attempt: number;
  outcome: RunOutcome;
  operation_id: string | null;
  operation_number: string | null;
  reason_code: string | null;
  amount_kop: bigint;
  idempotency_key: string;
  started_at: Date;
  finished_at: Date | null;
}

const SELECT_AUTOPAYMENT = `
  SELECT a.id, a.client_id, a.template_id, t.name AS template_name, a.day_of_month, a.amount_kop, a.ends_on::text AS ends_on,
         a.status, a.cycle_on::text AS cycle_on, a.next_run_on::text AS next_run_on, a.attempt, a.series, a.reminded_for::text AS reminded_for, a.failure_code,
         a.created_at, a.updated_at
  FROM autopayments a JOIN transfer_templates t ON t.id = a.template_id`;

const SELECT_RUN = `
  SELECT r.id, r.autopayment_id, r.run_date::text AS run_date, r.cycle_date::text AS cycle_date, r.series, r.attempt, r.outcome, r.operation_id, o.number AS operation_number,
         r.reason_code, r.amount_kop, r.idempotency_key, r.started_at, r.finished_at
  FROM autopayment_runs r LEFT JOIN operations o ON o.id = r.operation_id`;

function mapAutopayment(row: AutopaymentRow): AutopaymentRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    templateId: row.template_id,
    templateName: row.template_name,
    dayOfMonth: row.day_of_month,
    amount: row.amount_kop,
    endsOn: row.ends_on,
    status: row.status,
    cycleOn: row.cycle_on,
    nextRunOn: row.next_run_on,
    attempt: row.attempt,
    series: row.series,
    remindedFor: row.reminded_for,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    autopaymentId: row.autopayment_id,
    runDate: row.run_date,
    cycleDate: row.cycle_date,
    series: row.series,
    attempt: row.attempt,
    outcome: row.outcome,
    operationId: row.operation_id,
    operationNumber: row.operation_number,
    reasonCode: row.reason_code,
    amount: row.amount_kop,
    idempotencyKey: row.idempotency_key,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function listClientAutopayments(db: Db, clientId: string): Promise<AutopaymentRecord[]> {
  const result = await db.query<AutopaymentRow>(`${SELECT_AUTOPAYMENT} WHERE a.client_id = $1 ORDER BY a.created_at DESC, a.id`, [clientId]);
  return result.rows.map(mapAutopayment);
}

export async function findClientAutopayment(db: Db, clientId: string, id: string): Promise<AutopaymentRecord | null> {
  const result = await db.query<AutopaymentRow>(`${SELECT_AUTOPAYMENT} WHERE a.client_id = $1 AND a.id = $2`, [clientId, id]);
  const row = result.rows[0];
  return row ? mapAutopayment(row) : null;
}

export async function lockAutopayment(db: Db, id: string): Promise<AutopaymentRecord | null> {
  const result = await db.query<AutopaymentRow>(`${SELECT_AUTOPAYMENT} WHERE a.id = $1 FOR UPDATE OF a`, [id]);
  const row = result.rows[0];
  return row ? mapAutopayment(row) : null;
}

export interface NewAutopayment {
  clientId: string;
  templateId: string;
  dayOfMonth: number;
  amount: Kopecks;
  endsOn: string | null;
  nextRunOn: string;
  at: Date;
}

export async function insertAutopayment(db: Db, input: NewAutopayment): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO autopayments (client_id, template_id, day_of_month, amount_kop, ends_on, status, next_run_on, cycle_on, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $6, $7, $7) RETURNING id`,
    [input.clientId, input.templateId, input.dayOfMonth, input.amount, input.endsOn, input.nextRunOn, input.at],
  );
  return (result.rows[0] as { id: string }).id;
}

export interface AutopaymentState {
  status?: AutopaymentStatus;
  cycleOn?: string | null;
  nextRunOn?: string | null;
  attempt?: number;
  series?: number;
  failureCode?: string | null;
  remindedFor?: string;
}

export async function setAutopaymentState(db: Db, id: string, state: AutopaymentState, at: Date): Promise<void> {
  await db.query(
    `UPDATE autopayments SET
       status = COALESCE($2, status),
       next_run_on = CASE WHEN $3::boolean THEN $4::date ELSE next_run_on END,
       attempt = COALESCE($5, attempt),
       failure_code = CASE WHEN $6::boolean THEN $7 ELSE failure_code END,
       reminded_for = COALESCE($8::date, reminded_for),
       cycle_on = CASE WHEN $10::boolean THEN $11::date ELSE cycle_on END,
       series = COALESCE($12, series),
       updated_at = $9
     WHERE id = $1`,
    [
      id,
      state.status ?? null,
      state.nextRunOn !== undefined,
      state.nextRunOn ?? null,
      state.attempt ?? null,
      state.failureCode !== undefined,
      state.failureCode ?? null,
      state.remindedFor ?? null,
      at,
      state.cycleOn !== undefined,
      state.cycleOn ?? null,
      state.series ?? null,
    ],
  );
}

export async function listDueAutopaymentIds(db: Db, todayKey: string, limit: number): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT a.id FROM autopayments a WHERE a.status = 'ACTIVE' AND a.next_run_on <= $1::date
       AND NOT EXISTS (SELECT 1 FROM autopayment_runs r WHERE r.autopayment_id = a.id AND r.outcome = 'PENDING')
     ORDER BY a.next_run_on, a.created_at LIMIT $2`,
    [todayKey, limit],
  );
  return result.rows.map((row) => row.id);
}

export async function listReminderCandidates(db: Db, tomorrowKey: string): Promise<AutopaymentRecord[]> {
  const result = await db.query<AutopaymentRow>(
    `${SELECT_AUTOPAYMENT} WHERE a.status = 'ACTIVE' AND a.attempt = 0 AND a.next_run_on = $1::date
       AND a.reminded_for IS DISTINCT FROM a.next_run_on ORDER BY a.created_at`,
    [tomorrowKey],
  );
  return result.rows.map(mapAutopayment);
}

export async function listExpiredAutopaymentIds(db: Db, todayKey: string): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    "SELECT id FROM autopayments WHERE status IN ('ACTIVE', 'PAUSED', 'FAILED') AND ends_on < $1::date ORDER BY created_at",
    [todayKey],
  );
  return result.rows.map((row) => row.id);
}

export async function hasPendingRun(db: Db, autopaymentId: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM autopayment_runs WHERE autopayment_id = $1 AND outcome = 'PENDING' LIMIT 1", [autopaymentId]);
  return (result.rowCount ?? 0) > 0;
}

export interface NewRun {
  autopaymentId: string;
  runDate: string;
  cycleDate: string;
  series: number;
  attempt: number;
  amount: Kopecks;
  idempotencyKey: string;
  at: Date;
}

export async function insertRun(db: Db, input: NewRun): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO autopayment_runs (autopayment_id, run_date, cycle_date, series, attempt, outcome, amount_kop, idempotency_key, started_at)
     VALUES ($1, $2::date, $3::date, $4, $5, 'PENDING', $6, $7, $8) ON CONFLICT (autopayment_id, cycle_date, series, attempt) DO NOTHING RETURNING id`,
    [input.autopaymentId, input.runDate, input.cycleDate, input.series, input.attempt, input.amount, input.idempotencyKey, input.at],
  );
  return result.rows[0]?.id ?? null;
}

export async function listAutopaymentRuns(db: Db, autopaymentId: string): Promise<RunRecord[]> {
  const result = await db.query<RunRow>(`${SELECT_RUN} WHERE r.autopayment_id = $1 ORDER BY r.started_at DESC, r.attempt DESC`, [autopaymentId]);
  return result.rows.map(mapRun);
}

export async function findRun(db: Db, runId: string): Promise<RunRecord | null> {
  const result = await db.query<RunRow>(`${SELECT_RUN} WHERE r.id = $1`, [runId]);
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

export async function lockPendingRun(db: Db, runId: string): Promise<RunRecord | null> {
  const result = await db.query<RunRow>(`${SELECT_RUN} WHERE r.id = $1 AND r.outcome = 'PENDING' FOR UPDATE OF r`, [runId]);
  const row = result.rows[0];
  return row ? mapRun(row) : null;
}

export async function listPendingRunIds(db: Db, limit: number): Promise<string[]> {
  const result = await db.query<{ id: string }>(
    `SELECT r.id FROM autopayment_runs r LEFT JOIN operations o ON o.id = r.operation_id
     WHERE r.outcome = 'PENDING' AND (r.operation_id IS NULL OR o.status = ANY($2::text[])) ORDER BY r.started_at LIMIT $1`,
    [limit, TERMINAL_STATUSES],
  );
  return result.rows.map((row) => row.id);
}

export async function attachRunOperation(db: Db, runId: string, operationId: string): Promise<void> {
  await db.query('UPDATE autopayment_runs SET operation_id = $2 WHERE id = $1', [runId, operationId]);
}

export async function finishRun(db: Db, runId: string, outcome: 'EXECUTED' | 'FAILED', reasonCode: string | null, at: Date): Promise<void> {
  await db.query('UPDATE autopayment_runs SET outcome = $2, reason_code = $3, finished_at = $4 WHERE id = $1', [runId, outcome, reasonCode, at]);
}

export async function insertRunMarks(db: Db, runId: string, marks: readonly DefectMark[], at: Date): Promise<void> {
  for (const mark of marks) {
    await db.query(
      'INSERT INTO autopayment_run_marks (run_id, defect_code, details, created_at) VALUES ($1, $2, $3::jsonb, $4) ON CONFLICT (run_id, defect_code) DO NOTHING',
      [runId, mark.code, JSON.stringify(mark.details), at],
    );
  }
}

export async function listRunMarks(db: Db, runId: string): Promise<DefectMark[]> {
  const result = await db.query<{ defect_code: DefectMark['code']; details: Record<string, unknown> }>(
    'SELECT defect_code, details FROM autopayment_run_marks WHERE run_id = $1 ORDER BY created_at, defect_code',
    [runId],
  );
  return result.rows.map((row) => ({ code: row.defect_code, details: row.details }));
}

export async function maxRunSeries(db: Db, autopaymentId: string, cycleDate: string): Promise<number> {
  const result = await db.query<{ top: number | null }>(
    'SELECT MAX(series)::int AS top FROM autopayment_runs WHERE autopayment_id = $1 AND cycle_date = $2::date',
    [autopaymentId, cycleDate],
  );
  return result.rows[0]?.top ?? 0;
}
