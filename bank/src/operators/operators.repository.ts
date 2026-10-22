import type { Db } from '../db/pool';

export type OperatorRole = 'OPERATOR' | 'SENIOR';

export interface Operator {
  id: string;
  login: string;
  fullName: string;
  shortName: string;
  role: OperatorRole;
  status: 'ACTIVE' | 'BLOCKED';
}

interface OperatorRow {
  id: string;
  login: string;
  full_name: string;
  short_name: string;
  role: OperatorRole;
  status: 'ACTIVE' | 'BLOCKED';
  password_hash: string;
}

const COLUMNS = 'id, login, full_name, short_name, role, status, password_hash';

function mapOperator(row: OperatorRow): Operator {
  return { id: row.id, login: row.login, fullName: row.full_name, shortName: row.short_name, role: row.role, status: row.status };
}

export async function findOperatorWithHash(db: Db, login: string): Promise<{ operator: Operator; passwordHash: string } | null> {
  const result = await db.query<OperatorRow>(`SELECT ${COLUMNS} FROM operators WHERE login = $1`, [login]);
  const row = result.rows[0];
  return row ? { operator: mapOperator(row), passwordHash: row.password_hash } : null;
}

export async function findOperatorById(db: Db, id: string): Promise<Operator | null> {
  const result = await db.query<OperatorRow>(`SELECT ${COLUMNS} FROM operators WHERE id = $1`, [id]);
  const row = result.rows[0];
  return row ? mapOperator(row) : null;
}

export interface NewOperator {
  login: string;
  fullName: string;
  shortName: string;
  role: OperatorRole;
  passwordHash: string;
  createdAt: Date;
}

export async function insertOperator(db: Db, input: NewOperator): Promise<void> {
  await db.query(
    'INSERT INTO operators (login, full_name, short_name, role, password_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [input.login, input.fullName, input.shortName, input.role, input.passwordHash, input.createdAt],
  );
}

export async function insertOperatorSession(db: Db, operatorId: string, tokenHash: string, createdAt: Date, expiresAt: Date): Promise<void> {
  await db.query('INSERT INTO operator_sessions (operator_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
    operatorId,
    tokenHash,
    createdAt,
    expiresAt,
  ]);
}

export interface ActiveOperatorSession {
  sessionId: string;
  operator: Operator;
}

export async function findActiveOperatorSession(db: Db, tokenHash: string, now: Date): Promise<ActiveOperatorSession | null> {
  const result = await db.query<OperatorRow & { session_id: string }>(
    `SELECT s.id AS session_id, o.id, o.login, o.full_name, o.short_name, o.role, o.status, o.password_hash
     FROM operator_sessions s JOIN operators o ON o.id = s.operator_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
    [tokenHash, now],
  );
  const row = result.rows[0];
  return row ? { sessionId: row.session_id, operator: mapOperator(row) } : null;
}

export async function revokeOperatorSession(db: Db, sessionId: string, at: Date): Promise<void> {
  await db.query('UPDATE operator_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, at]);
}
