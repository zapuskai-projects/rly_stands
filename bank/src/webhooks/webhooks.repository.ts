import type { Pool } from 'pg';
import { withTransaction, type Db } from '../db/pool';
import type { WebhookEventName } from './webhook-signature';

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'FAILED';

export interface DeliveryAttempt {
  attempt: number;
  at: Date;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
}

export interface DeliveryRecord {
  eventId: string;
  partnerId: string;
  event: WebhookEventName;
  qrId: string;
  orderId: string;
  operationId: string;
  url: string;
  secret: string;
  body: string;
  status: DeliveryStatus;
  attemptsMade: number;
  nextAttemptAt: Date | null;
  createdAt: Date;
  attempts: DeliveryAttempt[];
}

interface DeliveryRow {
  event_id: string;
  partner_id: string;
  event: WebhookEventName;
  qr_id: string;
  order_id: string;
  operation_id: string;
  url: string;
  secret: string;
  body: string;
  status: DeliveryStatus;
  attempts_made: number;
  next_attempt_at: Date | null;
  created_at: Date;
}

interface AttemptRow {
  event_id: string;
  attempt: number;
  at: Date;
  status_code: number | null;
  error: string | null;
  duration_ms: number;
}

const SELECT_DELIVERY = `
  SELECT d.event_id, d.partner_id, d.event, d.qr_id, q.order_id, d.operation_id, d.url, d.secret, d.body, d.status,
         d.attempts_made, d.next_attempt_at, d.created_at
  FROM webhook_deliveries d JOIN qr_codes q ON q.id = d.qr_id`;

function mapDelivery(row: DeliveryRow, attempts: DeliveryAttempt[]): DeliveryRecord {
  return {
    eventId: row.event_id,
    partnerId: row.partner_id,
    event: row.event,
    qrId: row.qr_id,
    orderId: row.order_id,
    operationId: row.operation_id,
    url: row.url,
    secret: row.secret,
    body: row.body,
    status: row.status,
    attemptsMade: row.attempts_made,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    attempts,
  };
}

async function attemptsOf(db: Db, eventIds: readonly string[]): Promise<Map<string, DeliveryAttempt[]>> {
  const result = await db.query<AttemptRow>(
    'SELECT event_id, attempt, at, status_code, error, duration_ms FROM webhook_attempts WHERE event_id = ANY($1::uuid[]) ORDER BY event_id, attempt',
    [[...eventIds]],
  );
  const grouped = new Map<string, DeliveryAttempt[]>();
  for (const row of result.rows) {
    const list = grouped.get(row.event_id) ?? [];
    list.push({ attempt: row.attempt, at: row.at, statusCode: row.status_code, error: row.error, durationMs: row.duration_ms });
    grouped.set(row.event_id, list);
  }
  return grouped;
}

async function withAttempts(db: Db, rows: DeliveryRow[]): Promise<DeliveryRecord[]> {
  const attempts = await attemptsOf(db, rows.map((row) => row.event_id));
  return rows.map((row) => mapDelivery(row, attempts.get(row.event_id) ?? []));
}

export interface NewDelivery {
  eventId: string;
  partnerId: string;
  event: WebhookEventName;
  qrId: string;
  operationId: string;
  url: string;
  secret: string;
  body: string;
  nextAttemptAt: Date;
  createdAt: Date;
}

export async function insertDelivery(db: Db, input: NewDelivery): Promise<void> {
  await db.query(
    `INSERT INTO webhook_deliveries (event_id, partner_id, event, qr_id, operation_id, url, secret, body, next_attempt_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [input.eventId, input.partnerId, input.event, input.qrId, input.operationId, input.url, input.secret, input.body, input.nextAttemptAt, input.createdAt],
  );
}

export async function claimDueDeliveries(db: Db, now: Date, leaseMs: number, limit: number): Promise<DeliveryRecord[]> {
  const result = await db.query<DeliveryRow>(
    `WITH due AS (
       SELECT event_id FROM webhook_deliveries
       WHERE status = 'PENDING' AND next_attempt_at <= $1 ORDER BY next_attempt_at, created_at LIMIT $3 FOR UPDATE SKIP LOCKED)
     UPDATE webhook_deliveries d SET next_attempt_at = $2
     FROM due WHERE d.event_id = due.event_id
     RETURNING d.event_id, d.partner_id, d.event, d.qr_id, (SELECT order_id FROM qr_codes WHERE id = d.qr_id) AS order_id,
               d.operation_id, d.url, d.secret, d.body, d.status, d.attempts_made, d.next_attempt_at, d.created_at`,
    [now, new Date(now.getTime() + leaseMs), limit],
  );
  return result.rows.map((row) => mapDelivery(row, []));
}

export interface AttemptOutcome {
  at: Date;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
}

export async function recordAttempt(
  pool: Pool,
  delivery: DeliveryRecord,
  outcome: AttemptOutcome,
  next: { status: DeliveryStatus; nextAttemptAt: Date | null; finishedAt: Date | null },
  mark?: DeliveryMark,
): Promise<void> {
  const attempt = delivery.attemptsMade + 1;
  await withTransaction(pool, async (tx) => {
    await tx.query('INSERT INTO webhook_attempts (event_id, attempt, at, status_code, error, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)', [
      delivery.eventId,
      attempt,
      outcome.at,
      outcome.statusCode,
      outcome.error,
      outcome.durationMs,
    ]);
    await tx.query('UPDATE webhook_deliveries SET status = $2, attempts_made = $3, next_attempt_at = $4, finished_at = $5 WHERE event_id = $1', [
      delivery.eventId,
      next.status,
      attempt,
      next.nextAttemptAt,
      next.finishedAt,
    ]);
    if (mark) await insertDeliveryMark(tx, delivery.eventId, mark, outcome.at);
  });
}

export interface DeliveryMark {
  code: string;
  details: Record<string, unknown>;
}

export async function insertDeliveryMark(db: Db, eventId: string, mark: DeliveryMark, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO webhook_delivery_marks (event_id, defect_code, details, created_at) VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (event_id, defect_code) DO NOTHING`,
    [eventId, mark.code, JSON.stringify(mark.details), at],
  );
}

export async function listDeliveryMarks(db: Db, eventIds: readonly string[]): Promise<Map<string, DeliveryMark[]>> {
  const result = await db.query<{ event_id: string; defect_code: string; details: Record<string, unknown> }>(
    'SELECT event_id, defect_code, details FROM webhook_delivery_marks WHERE event_id = ANY($1::uuid[]) ORDER BY created_at, defect_code',
    [[...eventIds]],
  );
  const grouped = new Map<string, DeliveryMark[]>();
  for (const row of result.rows) {
    const list = grouped.get(row.event_id) ?? [];
    list.push({ code: row.defect_code, details: row.details });
    grouped.set(row.event_id, list);
  }
  return grouped;
}

export interface DeliveryFilter {
  partnerId?: string;
  qrId?: string;
  event?: WebhookEventName;
  label?: string;
}

export async function listDeliveries(db: Db, filter: DeliveryFilter, limit: number, offset: number): Promise<{ rows: DeliveryRecord[]; total: number }> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.partnerId) add('d.partner_id = ?', filter.partnerId);
  if (filter.qrId) add('d.qr_id = ?', filter.qrId);
  if (filter.event) add('d.event = ?', filter.event);
  if (filter.label) add('q.attempt_label = ?', filter.label);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const count = await db.query<{ total: bigint }>(`SELECT COUNT(*) AS total FROM webhook_deliveries d JOIN qr_codes q ON q.id = d.qr_id ${where}`, params);
  const page = await db.query<DeliveryRow>(
    `${SELECT_DELIVERY} ${where} ORDER BY d.created_at DESC, d.event DESC, d.event_id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { rows: await withAttempts(db, page.rows), total: Number((count.rows[0] as { total: bigint }).total) };
}
