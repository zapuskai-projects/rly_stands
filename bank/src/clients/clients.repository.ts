import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';

export type ClientKind = 'INDIVIDUAL' | 'ENTREPRENEUR';
export type ClientStatus = 'ACTIVE' | 'BLOCKED';

export interface Client {
  id: string;
  number: string;
  fullName: string;
  phone: string;
  kind: ClientKind;
  resident: boolean;
  inn: string | null;
  tariffCode: string;
  status: ClientStatus;
  technical: boolean;
  createdAt: Date;
}

interface ClientRow {
  id: string;
  number: string;
  full_name: string;
  phone: string;
  kind: ClientKind;
  resident: boolean;
  inn: string | null;
  tariff_code: string;
  status: ClientStatus;
  technical: boolean;
  created_at: Date;
}

const COLUMNS = 'id, number, full_name, phone, kind, resident, inn, tariff_code, status, technical, created_at';

function mapClient(row: ClientRow): Client {
  return {
    id: row.id,
    number: row.number,
    fullName: row.full_name,
    phone: row.phone,
    kind: row.kind,
    resident: row.resident,
    inn: row.inn,
    tariffCode: row.tariff_code,
    status: row.status,
    technical: row.technical,
    createdAt: row.created_at,
  };
}

export async function findClientById(db: Db, id: string): Promise<Client | null> {
  const result = await db.query<ClientRow>(`SELECT ${COLUMNS} FROM clients WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? mapClient(row) : null;
}

export async function findClientByPhone(db: Db, phone: string): Promise<Client | null> {
  const result = await db.query<ClientRow>(`SELECT ${COLUMNS} FROM clients WHERE phone = $1`, [phone]);
  const row = result.rows[0];
  return row ? mapClient(row) : null;
}

export interface NewClient {
  number: string;
  fullName: string;
  phone: string;
  kind: ClientKind;
  resident: boolean;
  inn: string | null;
  tariffCode: string;
  createdAt: Date;
  technical?: boolean;
}

export async function insertClient(db: Db, input: NewClient): Promise<Client> {
  const result = await db.query<ClientRow>(
    `INSERT INTO clients (number, full_name, phone, kind, resident, inn, tariff_code, created_at, technical)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ${COLUMNS}`,
    [input.number, input.fullName, input.phone, input.kind, input.resident, input.inn, input.tariffCode, input.createdAt, input.technical ?? false],
  );
  return mapClient(result.rows[0] as ClientRow);
}

export async function findDailyLimitOverride(db: Db, clientId: string): Promise<Kopecks | null> {
  const result = await db.query<{ amount_kop: bigint }>(
    "SELECT amount_kop FROM client_limits WHERE client_id = $1 AND limit_kind = 'DAILY_PHONE_TRANSFER'",
    [clientId],
  );
  const row = result.rows[0];
  return row ? row.amount_kop : null;
}

export async function lockClientForTransfers(db: Db, clientId: string): Promise<void> {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [clientId]);
}
