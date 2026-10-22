import type { Db } from '../db/pool';

export interface LoginChallenge {
  id: string;
  clientId: string;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface ChallengeRow {
  id: string;
  client_id: string;
  code_hash: string;
  attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
}

export async function supersedeOpenChallenges(db: Db, clientId: string, at: Date): Promise<void> {
  await db.query('UPDATE login_challenges SET consumed_at = $2 WHERE client_id = $1 AND consumed_at IS NULL', [clientId, at]);
}

export async function insertChallenge(
  db: Db,
  clientId: string,
  codeHash: string,
  expiresAt: Date,
  createdAt: Date,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    'INSERT INTO login_challenges (client_id, code_hash, expires_at, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
    [clientId, codeHash, expiresAt, createdAt],
  );
  return (result.rows[0] as { id: string }).id;
}

export async function lockChallenge(db: Db, challengeId: string): Promise<LoginChallenge | null> {
  const result = await db.query<ChallengeRow>(
    'SELECT id, client_id, code_hash, attempts, expires_at, consumed_at FROM login_challenges WHERE id = $1 FOR UPDATE',
    [challengeId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    codeHash: row.code_hash,
    attempts: row.attempts,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

export async function registerFailedAttempt(db: Db, challengeId: string): Promise<void> {
  await db.query('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = $1', [challengeId]);
}

export async function consumeChallenge(db: Db, challengeId: string, at: Date): Promise<void> {
  await db.query('UPDATE login_challenges SET consumed_at = $2 WHERE id = $1', [challengeId, at]);
}

export async function insertSession(db: Db, clientId: string, tokenHash: string, createdAt: Date, expiresAt: Date): Promise<void> {
  await db.query('INSERT INTO sessions (client_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
    clientId,
    tokenHash,
    createdAt,
    expiresAt,
  ]);
}

export interface ActiveSession {
  sessionId: string;
  clientId: string;
}

export async function findActiveSession(db: Db, tokenHash: string, now: Date): Promise<ActiveSession | null> {
  const result = await db.query<{ id: string; client_id: string }>(
    'SELECT id, client_id FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2',
    [tokenHash, now],
  );
  const row = result.rows[0];
  return row ? { sessionId: row.id, clientId: row.client_id } : null;
}

export async function revokeSession(db: Db, sessionId: string, at: Date): Promise<void> {
  await db.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, at]);
}
