import type { Kopecks } from '../accounts/money';
import type { Db } from '../db/pool';
import type { ClientKind, ClientStatus } from '../clients/clients.repository';

export interface OfficeClientRow {
  id: string;
  number: string;
  fullName: string;
  phone: string;
  kind: ClientKind;
  resident: boolean;
  inn: string | null;
  status: ClientStatus;
  tariffCode: string;
  tariffName: string;
  customerSince: Date;
  accountsCount: number;
  totalBalance: Kopecks;
}

interface ClientListRow {
  id: string;
  number: string;
  full_name: string;
  phone: string;
  kind: ClientKind;
  resident: boolean;
  inn: string | null;
  status: ClientStatus;
  tariff_code: string;
  tariff_name: string;
  created_at: Date;
  accounts_count: number;
  total_balance: bigint;
}

const SELECT_CLIENT = `
  SELECT c.id, c.number, c.full_name, c.phone, c.kind, c.resident, c.inn, c.status, c.tariff_code, t.name AS tariff_name, c.created_at,
         (SELECT COUNT(*)::int FROM accounts a WHERE a.client_id = c.id AND a.status <> 'CLOSED') AS accounts_count,
         (SELECT COALESCE(SUM(a.balance_kop), 0)::bigint FROM accounts a WHERE a.client_id = c.id AND a.status <> 'CLOSED') AS total_balance
  FROM clients c JOIN tariffs t ON t.code = c.tariff_code`;

function mapClient(row: ClientListRow): OfficeClientRow {
  return {
    id: row.id,
    number: row.number,
    fullName: row.full_name,
    phone: row.phone,
    kind: row.kind,
    resident: row.resident,
    inn: row.inn,
    status: row.status,
    tariffCode: row.tariff_code,
    tariffName: row.tariff_name,
    customerSince: row.created_at,
    accountsCount: row.accounts_count,
    totalBalance: row.total_balance,
  };
}

const SEARCH = `NOT c.technical AND ($1::text IS NULL OR strpos(lower(c.full_name), lower($1)) > 0 OR strpos(c.phone, $1) > 0 OR strpos(c.number, $1) = 1)`;

export async function listOfficeClients(db: Db, query: string | null, limit: number, offset: number): Promise<{ rows: OfficeClientRow[]; total: number }> {
  const count = await db.query<{ total: bigint }>(`SELECT COUNT(*) AS total FROM clients c WHERE ${SEARCH}`, [query]);
  const page = await db.query<ClientListRow>(`${SELECT_CLIENT} WHERE ${SEARCH} ORDER BY c.number LIMIT $2 OFFSET $3`, [query, limit, offset]);
  return { rows: page.rows.map(mapClient), total: Number((count.rows[0] as { total: bigint }).total) };
}

export async function findOfficeClient(db: Db, clientId: string): Promise<OfficeClientRow | null> {
  const result = await db.query<ClientListRow>(`${SELECT_CLIENT} WHERE c.id = $1 AND NOT c.technical`, [clientId]);
  const row = result.rows[0];
  return row ? mapClient(row) : null;
}

export async function setDailyLimitOverride(db: Db, clientId: string, amount: Kopecks | null): Promise<void> {
  if (amount === null) {
    await db.query("DELETE FROM client_limits WHERE client_id = $1 AND limit_kind = 'DAILY_PHONE_TRANSFER'", [clientId]);
    return;
  }
  await db.query(
    `INSERT INTO client_limits (client_id, limit_kind, amount_kop) VALUES ($1, 'DAILY_PHONE_TRANSFER', $2)
     ON CONFLICT (client_id, limit_kind) DO UPDATE SET amount_kop = EXCLUDED.amount_kop`,
    [clientId, amount],
  );
}
