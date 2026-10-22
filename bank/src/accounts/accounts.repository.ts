import type { Db } from '../db/pool';
import type { Kopecks } from './money';

export type AccountKind = 'CURRENT' | 'SAVINGS' | 'SETTLEMENT' | 'CORRESPONDENT' | 'INCOME' | 'OPENING';
export type AccountStatus = 'ACTIVE' | 'ARRESTED' | 'CLOSED';
export type SystemAccountKind = 'CORRESPONDENT' | 'INCOME' | 'OPENING';

export interface Account {
  id: string;
  number: string;
  clientId: string | null;
  kind: AccountKind;
  title: string;
  status: AccountStatus;
  isPrimary: boolean;
  balance: Kopecks;
  openedAt: Date;
}

interface AccountRow {
  id: string;
  number: string;
  client_id: string | null;
  kind: AccountKind;
  title: string;
  status: AccountStatus;
  is_primary: boolean;
  balance_kop: bigint;
  opened_at: Date;
}

const COLUMNS = 'id, number, client_id, kind, title, status, is_primary, balance_kop, opened_at';

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    number: row.number,
    clientId: row.client_id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    isPrimary: row.is_primary,
    balance: row.balance_kop,
    openedAt: row.opened_at,
  };
}

export async function listClientAccounts(db: Db, clientId: string): Promise<Account[]> {
  const result = await db.query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE client_id = $1 AND status <> 'CLOSED' ORDER BY is_primary DESC, opened_at, number`,
    [clientId],
  );
  return result.rows.map(mapAccount);
}

export async function findClientAccountById(db: Db, clientId: string, accountId: string): Promise<Account | null> {
  const result = await db.query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE client_id = $1 AND id = $2 AND status <> 'CLOSED'`,
    [clientId, accountId],
  );
  const row = result.rows[0];
  return row ? mapAccount(row) : null;
}

export async function findClientAccountByNumber(db: Db, clientId: string, number: string): Promise<Account | null> {
  const result = await db.query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE client_id = $1 AND number = $2 AND status <> 'CLOSED'`,
    [clientId, number],
  );
  const row = result.rows[0];
  return row ? mapAccount(row) : null;
}

export async function findPrimaryAccount(db: Db, clientId: string): Promise<Account | null> {
  const result = await db.query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE client_id = $1 AND is_primary AND status <> 'CLOSED'`,
    [clientId],
  );
  const row = result.rows[0];
  return row ? mapAccount(row) : null;
}

export async function findSystemAccount(db: Db, kind: SystemAccountKind): Promise<Account> {
  const result = await db.query<AccountRow>(`SELECT ${COLUMNS} FROM accounts WHERE kind = $1`, [kind]);
  const row = result.rows[0];
  if (!row) throw new Error(`Системный счёт ${kind} не создан`);
  return mapAccount(row);
}

export async function lockAccounts(db: Db, ids: readonly string[]): Promise<Map<string, Account>> {
  const result = await db.query<AccountRow>(
    `SELECT ${COLUMNS} FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [[...new Set(ids)]],
  );
  return new Map(result.rows.map((row) => [row.id, mapAccount(row)]));
}

export async function sumActiveHolds(db: Db, accountIds: readonly string[]): Promise<Map<string, Kopecks>> {
  const result = await db.query<{ account_id: string; held: bigint }>(
    `SELECT account_id, SUM(amount_kop)::bigint AS held FROM holds
     WHERE status = 'ACTIVE' AND account_id = ANY($1::uuid[]) GROUP BY account_id`,
    [[...accountIds]],
  );
  return new Map(result.rows.map((row) => [row.account_id, row.held]));
}

export interface NewAccount {
  number: string;
  clientId: string | null;
  kind: AccountKind;
  title: string;
  status?: AccountStatus;
  isPrimary?: boolean;
  openedAt: Date;
}

export async function insertAccount(db: Db, input: NewAccount): Promise<Account> {
  const result = await db.query<AccountRow>(
    `INSERT INTO accounts (number, client_id, kind, title, status, is_primary, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
    [input.number, input.clientId, input.kind, input.title, input.status ?? 'ACTIVE', input.isPrimary ?? false, input.openedAt],
  );
  return mapAccount(result.rows[0] as AccountRow);
}

export interface Card {
  id: string;
  accountId: string;
  number: string;
  product: string;
  holderName: string;
  expiryMonth: number;
  expiryYear: number;
  status: 'ACTIVE' | 'BLOCKED';
}

interface CardRow {
  id: string;
  account_id: string;
  number: string;
  product: string;
  holder_name: string;
  expiry_month: number;
  expiry_year: number;
  status: 'ACTIVE' | 'BLOCKED';
}

function mapCard(row: CardRow): Card {
  return {
    id: row.id,
    accountId: row.account_id,
    number: row.number,
    product: row.product,
    holderName: row.holder_name,
    expiryMonth: row.expiry_month,
    expiryYear: row.expiry_year,
    status: row.status,
  };
}

export async function listCardsByAccounts(db: Db, accountIds: readonly string[]): Promise<Card[]> {
  const result = await db.query<CardRow>(
    `SELECT id, account_id, number, product, holder_name, expiry_month, expiry_year, status
     FROM cards WHERE account_id = ANY($1::uuid[]) ORDER BY number`,
    [[...accountIds]],
  );
  return result.rows.map(mapCard);
}

export interface NewCard {
  number: string;
  clientId: string;
  accountId: string;
  product: string;
  holderName: string;
  expiryMonth: number;
  expiryYear: number;
}

export async function insertCard(db: Db, input: NewCard): Promise<void> {
  await db.query(
    `INSERT INTO cards (number, client_id, account_id, product, holder_name, expiry_month, expiry_year)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [input.number, input.clientId, input.accountId, input.product, input.holderName, input.expiryMonth, input.expiryYear],
  );
}
