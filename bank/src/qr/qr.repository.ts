import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';
import type { QrStatus } from './qr-rules';

export interface QrRecord {
  id: string;
  partnerId: string;
  partnerName: string;
  orderId: string;
  amount: Kopecks;
  description: string;
  status: QrStatus;
  ttlSeconds: number;
  commission: Kopecks;
  refunded: Kopecks;
  paidOperationId: string | null;
  paidOperationNumber: string | null;
  pendingOperationId: string | null;
  paidAt: Date | null;
  cancelledAt: Date | null;
  attemptLabel: string | null;
  createdAt: Date;
  expiresAt: Date;
}

interface QrRow {
  id: string;
  partner_id: string;
  partner_name: string;
  order_id: string;
  amount_kop: bigint;
  description: string;
  status: QrStatus;
  ttl_seconds: number;
  commission_kop: bigint;
  refunded_kop: bigint;
  paid_operation_id: string | null;
  paid_operation_number: string | null;
  pending_operation_id: string | null;
  paid_at: Date | null;
  cancelled_at: Date | null;
  attempt_label: string | null;
  created_at: Date;
  expires_at: Date;
}

const SELECT_QR = `
  SELECT q.id, q.partner_id, p.name AS partner_name, q.order_id, q.amount_kop, q.description, q.status, q.ttl_seconds,
         q.commission_kop, q.refunded_kop, q.paid_operation_id, po.number AS paid_operation_number, q.pending_operation_id,
         q.paid_at, q.cancelled_at, q.attempt_label, q.created_at, q.expires_at
  FROM qr_codes q JOIN partners p ON p.id = q.partner_id LEFT JOIN operations po ON po.id = q.paid_operation_id`;

function mapQr(row: QrRow): QrRecord {
  return {
    id: row.id,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    orderId: row.order_id,
    amount: row.amount_kop,
    description: row.description,
    status: row.status,
    ttlSeconds: row.ttl_seconds,
    commission: row.commission_kop,
    refunded: row.refunded_kop,
    paidOperationId: row.paid_operation_id,
    paidOperationNumber: row.paid_operation_number,
    pendingOperationId: row.pending_operation_id,
    paidAt: row.paid_at,
    cancelledAt: row.cancelled_at,
    attemptLabel: row.attempt_label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export interface NewQr {
  partnerId: string;
  orderId: string;
  amount: Kopecks;
  description: string;
  ttlSeconds: number;
  attemptLabel: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export async function insertQrIfAbsent(db: Db, input: NewQr): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO qr_codes (partner_id, order_id, amount_kop, description, ttl_seconds, attempt_label, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (partner_id, order_id) DO NOTHING RETURNING id`,
    [input.partnerId, input.orderId, input.amount, input.description, input.ttlSeconds, input.attemptLabel, input.createdAt, input.expiresAt],
  );
  return result.rows[0]?.id ?? null;
}

export async function findQr(db: Db, qrId: string): Promise<QrRecord | null> {
  const result = await db.query<QrRow>(`${SELECT_QR} WHERE q.id = $1`, [qrId]);
  const row = result.rows[0];
  return row ? mapQr(row) : null;
}

export async function lockQr(db: Db, qrId: string): Promise<QrRecord | null> {
  const result = await db.query<QrRow>(`${SELECT_QR} WHERE q.id = $1 FOR UPDATE OF q`, [qrId]);
  const row = result.rows[0];
  return row ? mapQr(row) : null;
}

export async function findPartnerQr(db: Db, partnerId: string, qrId: string, forUpdate = false): Promise<QrRecord | null> {
  const result = await db.query<QrRow>(`${SELECT_QR} WHERE q.partner_id = $1 AND q.id = $2${forUpdate ? ' FOR UPDATE OF q' : ''}`, [partnerId, qrId]);
  const row = result.rows[0];
  return row ? mapQr(row) : null;
}

export async function findQrByOrder(db: Db, partnerId: string, orderId: string): Promise<QrRecord | null> {
  const result = await db.query<QrRow>(`${SELECT_QR} WHERE q.partner_id = $1 AND q.order_id = $2`, [partnerId, orderId]);
  const row = result.rows[0];
  return row ? mapQr(row) : null;
}

export async function setPendingPayment(db: Db, qrId: string, operationId: string): Promise<void> {
  await db.query('UPDATE qr_codes SET pending_operation_id = $2 WHERE id = $1', [qrId, operationId]);
}

export async function clearPendingPayment(db: Db, operationId: string): Promise<void> {
  await db.query('UPDATE qr_codes SET pending_operation_id = NULL WHERE pending_operation_id = $1', [operationId]);
}

export async function markQrPaid(db: Db, qrId: string, operationId: string, commission: Kopecks, at: Date): Promise<void> {
  await db.query(
    `UPDATE qr_codes SET status = 'PAID', paid_operation_id = $2, commission_kop = $3, paid_at = $4, pending_operation_id = NULL
     WHERE id = $1 AND status IN ('CREATED', 'EXPIRED')`,
    [qrId, operationId, commission, at],
  );
}

export async function markQrCancelled(db: Db, qrId: string, at: Date): Promise<void> {
  await db.query("UPDATE qr_codes SET status = 'CANCELLED', cancelled_at = $2 WHERE id = $1 AND status = 'CREATED'", [qrId, at]);
}

export async function expireDueQrCodes(db: Db, now: Date): Promise<number> {
  const result = await db.query(
    "UPDATE qr_codes SET status = 'EXPIRED' WHERE status = 'CREATED' AND pending_operation_id IS NULL AND expires_at <= $1",
    [now],
  );
  return result.rowCount ?? 0;
}

export async function applyQrRefund(db: Db, qrId: string, amount: Kopecks): Promise<void> {
  await db.query(
    "UPDATE qr_codes SET refunded_kop = refunded_kop + $2, status = CASE WHEN refunded_kop + $2 >= amount_kop THEN 'REFUNDED' ELSE 'PARTIALLY_REFUNDED' END WHERE id = $1",
    [qrId, amount],
  );
}

export interface QrFilter {
  label?: string;
  qrId?: string;
  orderId?: string;
}

export async function listQrCodes(db: Db, filter: QrFilter, limit: number): Promise<QrRecord[]> {
  const result = await db.query<QrRow>(
    `${SELECT_QR} WHERE ($1::text IS NULL OR q.attempt_label = $1) AND ($2::uuid IS NULL OR q.id = $2) AND ($3::text IS NULL OR q.order_id = $3)
     ORDER BY q.created_at, q.id LIMIT $4`,
    [filter.label ?? null, filter.qrId ?? null, filter.orderId ?? null, limit],
  );
  return result.rows.map(mapQr);
}
