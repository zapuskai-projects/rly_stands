import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';
import { statusChangedMessage } from '../events/builders';
import { enqueueOutbox } from '../events/outbox.repository';
import { BANK } from '../shared/bank-identity';
import { canTransition, LIMIT_COUNTED_STATUSES, type OperationStatus } from './status';

export type OperationType = 'OWN_TRANSFER' | 'PHONE_TRANSFER';
export type OperationRoute = 'INTERNAL' | 'SBP';

export interface OperationRecord {
  id: string;
  number: string;
  clientId: string;
  type: OperationType;
  route: OperationRoute;
  status: OperationStatus;
  fromAccountId: string;
  fromAccountNumber: string;
  toAccountId: string | null;
  toAccountNumber: string | null;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  recipientBankName: string | null;
  recipientName: string | null;
  amount: Kopecks;
  fee: Kopecks;
  comment: string | null;
  rejectCode: string | null;
  rejectMessage: string | null;
  requestId: string | null;
  templateId: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface StatusHistoryRecord {
  status: OperationStatus;
  reasonCode: string | null;
  comment: string | null;
  changedAt: Date;
}

interface OperationRow {
  id: string;
  number: string;
  client_id: string;
  type: OperationType;
  route: OperationRoute;
  status: OperationStatus;
  from_account_id: string;
  from_account_number: string;
  to_account_id: string | null;
  to_account_number: string | null;
  recipient_phone: string | null;
  recipient_bank_code: string | null;
  recipient_bank_name: string | null;
  recipient_name: string | null;
  amount_kop: bigint;
  fee_kop: bigint;
  comment: string | null;
  reject_code: string | null;
  reject_message: string | null;
  request_id: string | null;
  template_id: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

const SELECT_VIEW = `
  SELECT o.id, o.number, o.client_id, o.type, o.route, o.status, o.from_account_id, fa.number AS from_account_number,
         o.to_account_id, ta.number AS to_account_number, o.recipient_phone, o.recipient_bank_code,
         pb.name AS recipient_bank_name, o.recipient_name, o.amount_kop, o.fee_kop, o.comment,
         o.reject_code, o.reject_message, o.request_id, o.template_id, o.created_at, o.updated_at, o.completed_at
  FROM operations o
  JOIN accounts fa ON fa.id = o.from_account_id
  LEFT JOIN accounts ta ON ta.id = o.to_account_id
  LEFT JOIN partner_banks pb ON pb.code = o.recipient_bank_code`;

function mapOperation(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    number: row.number,
    clientId: row.client_id,
    type: row.type,
    route: row.route,
    status: row.status,
    fromAccountId: row.from_account_id,
    fromAccountNumber: row.from_account_number,
    toAccountId: row.to_account_id,
    toAccountNumber: row.to_account_number,
    recipientPhone: row.recipient_phone,
    recipientBankCode: row.recipient_bank_code,
    recipientBankName: row.recipient_bank_code === BANK.code ? BANK.name : row.recipient_bank_name,
    recipientName: row.recipient_name,
    amount: row.amount_kop,
    fee: row.fee_kop,
    comment: row.comment,
    rejectCode: row.reject_code,
    rejectMessage: row.reject_message,
    requestId: row.request_id,
    templateId: row.template_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export interface NewOperation {
  clientId: string;
  type: OperationType;
  route: OperationRoute;
  fromAccountId: string;
  toAccountId: string | null;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  recipientName: string | null;
  amount: Kopecks;
  fee: Kopecks;
  comment: string | null;
  attemptLabel: string | null;
  requestId: string;
  templateId?: string | null;
  createdAt: Date;
}

export async function insertOperation(db: Db, input: NewOperation): Promise<{ id: string; number: string }> {
  const result = await db.query<{ id: string; number: string }>(
    `INSERT INTO operations (client_id, type, route, status, from_account_id, to_account_id, recipient_phone,
       recipient_bank_code, recipient_name, amount_kop, fee_kop, comment, attempt_label, request_id, created_at, updated_at, template_id)
     VALUES ($1, $2, $3, 'CREATED', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $15)
     RETURNING id, number`,
    [
      input.clientId,
      input.type,
      input.route,
      input.fromAccountId,
      input.toAccountId,
      input.recipientPhone,
      input.recipientBankCode,
      input.recipientName,
      input.amount,
      input.fee,
      input.comment,
      input.attemptLabel,
      input.requestId,
      input.createdAt,
      input.templateId ?? null,
    ],
  );
  const created = result.rows[0] as { id: string; number: string };
  await db.query("INSERT INTO operation_status_history (operation_id, status, changed_at) VALUES ($1, 'CREATED', $2)", [
    created.id,
    input.createdAt,
  ]);
  return created;
}

export interface TransitionOptions {
  at: Date;
  reasonCode?: string;
  comment?: string;
  actor?: string;
  requestId?: string;
}

interface LockedStatusRow {
  status: OperationStatus;
  number: string;
  request_id: string | null;
  client_number: string;
}

export async function transitionOperation(
  db: Db,
  operationId: string,
  to: OperationStatus,
  options: TransitionOptions,
): Promise<void> {
  const current = await db.query<LockedStatusRow>(
    `SELECT o.status, o.number, o.request_id, c.number AS client_number FROM operations o
     JOIN clients c ON c.id = o.client_id WHERE o.id = $1 FOR UPDATE OF o`,
    [operationId],
  );
  const row = current.rows[0];
  if (!row) throw new Error(`Операция ${operationId} не найдена`);
  if (!canTransition(row.status, to)) throw new Error(`Переход ${row.status} → ${to} недопустим`);
  const rejected = to === 'REJECTED';
  await db.query(
    `UPDATE operations SET status = $2, updated_at = $3,
       completed_at = CASE WHEN $2 = 'COMPLETED' THEN $3 ELSE completed_at END,
       reject_code = CASE WHEN $4::boolean THEN $5 ELSE reject_code END,
       reject_message = CASE WHEN $4::boolean THEN $6 ELSE reject_message END
     WHERE id = $1`,
    [operationId, to, options.at, rejected, options.reasonCode ?? null, options.comment ?? null],
  );
  await db.query(
    'INSERT INTO operation_status_history (operation_id, status, reason_code, comment, actor, changed_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [operationId, to, options.reasonCode ?? null, options.comment ?? null, options.actor ?? 'SYSTEM', options.at],
  );
  await enqueueOutbox(
    db,
    statusChangedMessage({
      operationId,
      operationNumber: row.number,
      clientNumber: row.client_number,
      previousStatus: row.status,
      status: to,
      reasonCode: options.reasonCode ?? null,
      changedAt: options.at,
      requestId: options.requestId ?? row.request_id ?? 'unknown',
    }),
  );
}

export async function lockOperation(db: Db, operationId: string): Promise<OperationRecord | null> {
  const result = await db.query<OperationRow>(`${SELECT_VIEW} WHERE o.id = $1 FOR UPDATE OF o`, [operationId]);
  const row = result.rows[0];
  return row ? mapOperation(row) : null;
}

export async function clearOperationFee(db: Db, operationId: string): Promise<void> {
  await db.query('UPDATE operations SET fee_kop = 0 WHERE id = $1', [operationId]);
}

export async function findClientOperation(db: Db, clientId: string, operationId: string): Promise<OperationRecord | null> {
  const result = await db.query<OperationRow>(`${SELECT_VIEW} WHERE o.client_id = $1 AND o.id = $2`, [clientId, operationId]);
  const row = result.rows[0];
  return row ? mapOperation(row) : null;
}

export interface OperationFilter {
  status?: OperationStatus;
  type?: OperationType;
  createdFrom?: Date;
  createdBefore?: Date;
  number?: string;
}

export async function listClientOperations(
  db: Db,
  clientId: string,
  filter: OperationFilter,
  limit: number,
  offset: number,
): Promise<{ rows: OperationRecord[]; total: number }> {
  const params: unknown[] = [clientId];
  const conditions = ['o.client_id = $1'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.status) add('o.status = ?', filter.status);
  if (filter.type) add('o.type = ?', filter.type);
  if (filter.createdFrom) add('o.created_at >= ?', filter.createdFrom);
  if (filter.createdBefore) add('o.created_at < ?', filter.createdBefore);
  if (filter.number) add('o.number = ?', filter.number);
  const where = conditions.join(' AND ');
  const count = await db.query<{ total: bigint }>(`SELECT COUNT(*) AS total FROM operations o WHERE ${where}`, params);
  const page = await db.query<OperationRow>(
    `${SELECT_VIEW} WHERE ${where} ORDER BY o.created_at DESC, o.number DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { rows: page.rows.map(mapOperation), total: Number((count.rows[0] as { total: bigint }).total) };
}

export async function loadStatusHistories(db: Db, operationIds: readonly string[]): Promise<Map<string, StatusHistoryRecord[]>> {
  const result = await db.query<{
    operation_id: string;
    status: OperationStatus;
    reason_code: string | null;
    comment: string | null;
    changed_at: Date;
  }>(
    `SELECT operation_id, status, reason_code, comment, changed_at FROM operation_status_history
     WHERE operation_id = ANY($1::uuid[]) ORDER BY id`,
    [[...operationIds]],
  );
  const histories = new Map<string, StatusHistoryRecord[]>();
  for (const row of result.rows) {
    const list = histories.get(row.operation_id) ?? [];
    list.push({ status: row.status, reasonCode: row.reason_code, comment: row.comment, changedAt: row.changed_at });
    histories.set(row.operation_id, list);
  }
  return histories;
}

export async function sumPhoneTransferVolume(
  db: Db,
  clientId: string,
  from: Date,
  toExclusive: Date,
  route: OperationRoute | null = null,
): Promise<Kopecks> {
  const result = await db.query<{ total: bigint }>(
    `SELECT COALESCE(SUM(amount_kop), 0)::bigint AS total FROM operations
     WHERE client_id = $1 AND type = 'PHONE_TRANSFER' AND status = ANY($2::text[])
       AND created_at >= $3 AND created_at < $4 AND ($5::text IS NULL OR route = $5)`,
    [clientId, [...LIMIT_COUNTED_STATUSES], from, toExclusive, route],
  );
  return (result.rows[0] as { total: bigint }).total;
}

export interface IdempotencyRecord {
  requestHash: string;
  operationId: string;
}

export async function findIdempotencyRecord(db: Db, clientId: string, key: string): Promise<IdempotencyRecord | null> {
  const result = await db.query<{ request_hash: string; operation_id: string }>(
    'SELECT request_hash, operation_id FROM idempotency_keys WHERE client_id = $1 AND key = $2',
    [clientId, key],
  );
  const row = result.rows[0];
  return row ? { requestHash: row.request_hash, operationId: row.operation_id } : null;
}

export async function insertIdempotencyRecord(
  db: Db,
  clientId: string,
  key: string,
  requestHash: string,
  operationId: string,
  createdAt: Date,
): Promise<void> {
  await db.query(
    'INSERT INTO idempotency_keys (client_id, key, request_hash, operation_id, created_at) VALUES ($1, $2, $3, $4, $5)',
    [clientId, key, requestHash, operationId, createdAt],
  );
}

const SUCCESSFUL_STATUSES = ['COMPLETED', 'PROCESSING'];
const USUAL_AMOUNT_SAMPLE = 20;

export interface BeforeMark {
  createdAt: Date;
  number: string;
}

const BEFORE_CLAUSE = '($2::timestamptz IS NULL OR (o.created_at, o.number) < ($2, $3))';

export async function findOperationOfAnyClient(db: Db, operationId: string): Promise<OperationRecord | null> {
  const result = await db.query<OperationRow>(`${SELECT_VIEW} WHERE o.id = $1`, [operationId]);
  const row = result.rows[0];
  return row ? mapOperation(row) : null;
}

export async function hasSuccessfulTransferTo(
  db: Db,
  clientId: string,
  phone: string | null,
  bankCode: string | null,
  before: BeforeMark | null = null,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM operations o
     WHERE ${BEFORE_CLAUSE} AND o.client_id = $1 AND o.type = 'PHONE_TRANSFER' AND o.recipient_phone = $4 AND o.recipient_bank_code = $5
       AND o.status = ANY($6::text[]) LIMIT 1`,
    [clientId, before?.createdAt ?? null, before?.number ?? null, phone, bankCode, SUCCESSFUL_STATUSES],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function loadUsualAmounts(db: Db, clientId: string, before: BeforeMark | null = null): Promise<{ count: number; total: Kopecks }> {
  const result = await db.query<{ count: number; total: bigint }>(
    `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount_kop), 0)::bigint AS total FROM (
       SELECT o.amount_kop FROM operations o
       WHERE ${BEFORE_CLAUSE} AND o.client_id = $1 AND o.type = 'PHONE_TRANSFER' AND o.status = ANY($4::text[])
       ORDER BY o.created_at DESC, o.number DESC LIMIT $5) recent`,
    [clientId, before?.createdAt ?? null, before?.number ?? null, SUCCESSFUL_STATUSES, USUAL_AMOUNT_SAMPLE],
  );
  return result.rows[0] as { count: number; total: Kopecks };
}
