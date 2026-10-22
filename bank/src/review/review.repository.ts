import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';
import type { RuleHit } from '../events/payloads';
import { BANK } from '../shared/bank-identity';

export type ReviewState = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface ManualReview {
  operationId: string;
  state: ReviewState;
  deadlineAt: Date;
}

export interface ReviewItem {
  operationId: string;
  operationNumber: string;
  operationStatus: string;
  clientNumber: string;
  clientName: string;
  type: string;
  route: string;
  amount: Kopecks;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  recipientBankName: string | null;
  recipientName: string | null;
  score: number;
  rules: RuleHit[];
  state: ReviewState;
  createdAt: Date;
  deadlineAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  comment: string | null;
}

interface ItemRow {
  operation_id: string;
  number: string;
  op_status: string;
  client_number: string;
  full_name: string;
  type: string;
  route: string;
  amount_kop: bigint;
  recipient_phone: string | null;
  recipient_bank_code: string | null;
  bank_name: string | null;
  recipient_name: string | null;
  score: number | null;
  rules: RuleHit[] | null;
  state: ReviewState;
  created_at: Date;
  deadline_at: Date;
  resolved_at: Date | null;
  resolved_by: string | null;
  comment: string | null;
}

const SELECT_ITEM = `
  SELECT r.operation_id, o.number, o.status AS op_status, c.number AS client_number, c.full_name, o.type, o.route,
         o.amount_kop, o.recipient_phone, o.recipient_bank_code, pb.name AS bank_name, o.recipient_name, d.score, d.rules,
         r.state, r.created_at, r.deadline_at, r.resolved_at, r.resolved_by, r.comment
  FROM manual_reviews r
  JOIN operations o ON o.id = r.operation_id
  JOIN clients c ON c.id = o.client_id
  LEFT JOIN partner_banks pb ON pb.code = o.recipient_bank_code
  LEFT JOIN antifraud_decisions d ON d.operation_id = r.operation_id`;

function mapItem(row: ItemRow): ReviewItem {
  return {
    operationId: row.operation_id,
    operationNumber: row.number,
    operationStatus: row.op_status,
    clientNumber: row.client_number,
    clientName: row.full_name,
    type: row.type,
    route: row.route,
    amount: row.amount_kop,
    recipientPhone: row.recipient_phone,
    recipientBankCode: row.recipient_bank_code,
    recipientBankName: row.recipient_bank_code === BANK.code ? BANK.name : row.bank_name,
    recipientName: row.recipient_name,
    score: row.score ?? 0,
    rules: row.rules ?? [],
    state: row.state,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    comment: row.comment,
  };
}

export async function insertManualReview(db: Db, operationId: string, deadlineAt: Date, createdAt: Date): Promise<void> {
  await db.query('INSERT INTO manual_reviews (operation_id, deadline_at, created_at) VALUES ($1, $2, $3)', [
    operationId,
    deadlineAt,
    createdAt,
  ]);
}

export async function lockReview(db: Db, operationId: string): Promise<ManualReview | null> {
  const result = await db.query<{ operation_id: string; state: ReviewState; deadline_at: Date }>(
    'SELECT operation_id, state, deadline_at FROM manual_reviews WHERE operation_id = $1 FOR UPDATE',
    [operationId],
  );
  const row = result.rows[0];
  return row ? { operationId: row.operation_id, state: row.state, deadlineAt: row.deadline_at } : null;
}

export async function resolveReview(
  db: Db,
  operationId: string,
  state: Exclude<ReviewState, 'PENDING'>,
  resolvedAt: Date,
  resolvedBy: string,
  comment: string | null,
): Promise<void> {
  await db.query(
    'UPDATE manual_reviews SET state = $2, resolved_at = $3, resolved_by = $4, comment = $5 WHERE operation_id = $1',
    [operationId, state, resolvedAt, resolvedBy, comment],
  );
}

export async function listOverdueReviewIds(db: Db, now: Date, limit: number): Promise<string[]> {
  const result = await db.query<{ operation_id: string }>(
    "SELECT operation_id FROM manual_reviews WHERE state = 'PENDING' AND deadline_at <= $1 ORDER BY deadline_at LIMIT $2",
    [now, limit],
  );
  return result.rows.map((row) => row.operation_id);
}

export async function findReviewItem(db: Db, operationId: string): Promise<ReviewItem | null> {
  const result = await db.query<ItemRow>(`${SELECT_ITEM} WHERE r.operation_id = $1`, [operationId]);
  const row = result.rows[0];
  return row ? mapItem(row) : null;
}

export async function listReviewItems(
  db: Db,
  state: ReviewState | null,
  limit: number,
  offset: number,
): Promise<{ rows: ReviewItem[]; total: number }> {
  const count = await db.query<{ total: bigint }>(
    `SELECT COUNT(*) AS total FROM manual_reviews r JOIN operations o ON o.id = r.operation_id JOIN clients c ON c.id = o.client_id
     WHERE NOT c.technical AND ($1::text IS NULL OR r.state = $1)`,
    [state],
  );
  const page = await db.query<ItemRow>(
    `${SELECT_ITEM} WHERE NOT c.technical AND ($1::text IS NULL OR r.state = $1) ORDER BY r.deadline_at, r.operation_id LIMIT $2 OFFSET $3`,
    [state, limit, offset],
  );
  return { rows: page.rows.map(mapItem), total: Number((count.rows[0] as { total: bigint }).total) };
}
