import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';
import { BANK } from '../shared/bank-identity';
import type { OperationRoute, OperationType } from '../payments/operations.repository';
import type { OperationStatus } from '../payments/status';

export interface OfficeOperationRow {
  id: string;
  number: string;
  clientNumber: string;
  clientName: string;
  type: OperationType;
  route: OperationRoute;
  status: OperationStatus;
  amount: Kopecks;
  fee: Kopecks;
  recipientPhone: string | null;
  recipientBankCode: string | null;
  recipientBankName: string | null;
  recipientName: string | null;
  createdAt: Date;
}

interface Row {
  id: string;
  number: string;
  client_number: string;
  full_name: string;
  type: OperationType;
  route: OperationRoute;
  status: OperationStatus;
  amount_kop: bigint;
  fee_kop: bigint;
  recipient_phone: string | null;
  recipient_bank_code: string | null;
  bank_name: string | null;
  recipient_name: string | null;
  created_at: Date;
}

const SELECT_ROW = `
  SELECT o.id, o.number, c.number AS client_number, c.full_name, o.type, o.route, o.status, o.amount_kop, o.fee_kop,
         o.recipient_phone, o.recipient_bank_code, pb.name AS bank_name, o.recipient_name, o.created_at
  FROM operations o JOIN clients c ON c.id = o.client_id LEFT JOIN partner_banks pb ON pb.code = o.recipient_bank_code`;

function mapRow(row: Row): OfficeOperationRow {
  return {
    id: row.id,
    number: row.number,
    clientNumber: row.client_number,
    clientName: row.full_name,
    type: row.type,
    route: row.route,
    status: row.status,
    amount: row.amount_kop,
    fee: row.fee_kop,
    recipientPhone: row.recipient_phone,
    recipientBankCode: row.recipient_bank_code,
    recipientBankName: row.recipient_bank_code === BANK.code ? BANK.name : row.bank_name,
    recipientName: row.recipient_name,
    createdAt: row.created_at,
  };
}

export interface OfficeOperationFilter {
  number?: string;
  clientNumber?: string;
  status?: OperationStatus;
  type?: OperationType;
}

export async function listOfficeOperations(
  db: Db,
  filter: OfficeOperationFilter,
  limit: number,
  offset: number,
): Promise<{ rows: OfficeOperationRow[]; total: number }> {
  const params: unknown[] = [];
  const conditions: string[] = ['NOT c.technical'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.number) add('o.number = ?', filter.number);
  if (filter.clientNumber) add('c.number = ?', filter.clientNumber);
  if (filter.status) add('o.status = ?', filter.status);
  if (filter.type) add('o.type = ?', filter.type);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const count = await db.query<{ total: bigint }>(`SELECT COUNT(*) AS total FROM operations o JOIN clients c ON c.id = o.client_id ${where}`, params);
  const page = await db.query<Row>(
    `${SELECT_ROW} ${where} ORDER BY o.created_at DESC, o.number DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { rows: page.rows.map(mapRow), total: Number((count.rows[0] as { total: bigint }).total) };
}

export async function listClientRecentOperations(db: Db, clientId: string, limit: number): Promise<OfficeOperationRow[]> {
  const result = await db.query<Row>(`${SELECT_ROW} WHERE o.client_id = $1 ORDER BY o.created_at DESC, o.number DESC LIMIT $2`, [clientId, limit]);
  return result.rows.map(mapRow);
}
