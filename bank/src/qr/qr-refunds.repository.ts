import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';

export interface RefundRecord {
  id: string;
  qrId: string;
  operationId: string;
  operationNumber: string;
  amount: Kopecks;
  requestHash: string;
  createdAt: Date;
}

interface RefundRow {
  id: string;
  qr_id: string;
  operation_id: string;
  operation_number: string;
  amount_kop: bigint;
  request_hash: string;
  created_at: Date;
}

const SELECT_REFUND = `
  SELECT r.id, r.qr_id, r.operation_id, o.number AS operation_number, r.amount_kop, r.request_hash, r.created_at
  FROM qr_refunds r JOIN operations o ON o.id = r.operation_id`;

function mapRefund(row: RefundRow): RefundRecord {
  return {
    id: row.id,
    qrId: row.qr_id,
    operationId: row.operation_id,
    operationNumber: row.operation_number,
    amount: row.amount_kop,
    requestHash: row.request_hash,
    createdAt: row.created_at,
  };
}

export async function findRefundByKey(db: Db, partnerId: string, key: string): Promise<RefundRecord | null> {
  const result = await db.query<RefundRow>(`${SELECT_REFUND} WHERE r.partner_id = $1 AND r.idempotency_key = $2`, [partnerId, key]);
  const row = result.rows[0];
  return row ? mapRefund(row) : null;
}

export interface NewRefund {
  qrId: string;
  partnerId: string;
  operationId: string;
  amount: Kopecks;
  idempotencyKey: string;
  requestHash: string;
  createdAt: Date;
}

export async function insertRefund(db: Db, input: NewRefund): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO qr_refunds (qr_id, partner_id, operation_id, amount_kop, idempotency_key, request_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.qrId, input.partnerId, input.operationId, input.amount, input.idempotencyKey, input.requestHash, input.createdAt],
  );
  return (result.rows[0] as { id: string }).id;
}

export async function listQrRefunds(db: Db, qrIds: readonly string[]): Promise<Map<string, RefundRecord[]>> {
  const result = await db.query<RefundRow>(`${SELECT_REFUND} WHERE r.qr_id = ANY($1::uuid[]) ORDER BY r.created_at, r.id`, [[...qrIds]]);
  const grouped = new Map<string, RefundRecord[]>();
  for (const row of result.rows) {
    const list = grouped.get(row.qr_id) ?? [];
    list.push(mapRefund(row));
    grouped.set(row.qr_id, list);
  }
  return grouped;
}
