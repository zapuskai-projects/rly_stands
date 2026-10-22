import type { Db } from '../db/pool';

export interface OutboxMessage {
  destination: 'KAFKA' | 'RABBIT';
  topic: string;
  key: string | null;
  headers: Record<string, string>;
  payload: unknown;
  createdAt: Date;
}

export interface OutboxRecord extends OutboxMessage {
  id: number;
  attempts: number;
}

interface OutboxRow {
  id: bigint;
  destination: 'KAFKA' | 'RABBIT';
  topic: string;
  message_key: string | null;
  headers: Record<string, string>;
  payload: unknown;
  created_at: Date;
  attempts: number;
}

export async function enqueueOutbox(db: Db, message: OutboxMessage): Promise<void> {
  await db.query(
    'INSERT INTO outbox_events (destination, topic, message_key, headers, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [message.destination, message.topic, message.key, JSON.stringify(message.headers), JSON.stringify(message.payload), message.createdAt],
  );
}

export async function claimOutboxBatch(db: Db, limit: number): Promise<OutboxRecord[]> {
  const result = await db.query<OutboxRow>(
    `SELECT id, destination, topic, message_key, headers, payload, created_at, attempts FROM outbox_events
     WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    destination: row.destination,
    topic: row.topic,
    key: row.message_key,
    headers: row.headers,
    payload: row.payload,
    createdAt: row.created_at,
    attempts: row.attempts,
  }));
}

export async function markOutboxPublished(db: Db, id: number): Promise<void> {
  await db.query('UPDATE outbox_events SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1', [id]);
}

export async function markOutboxFailed(db: Db, id: number, error: string): Promise<void> {
  await db.query('UPDATE outbox_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1', [id, error.slice(0, 500)]);
}

export async function countPendingOutbox(db: Db): Promise<number> {
  const result = await db.query<{ total: bigint }>('SELECT COUNT(*) AS total FROM outbox_events WHERE published_at IS NULL');
  return Number((result.rows[0] as { total: bigint }).total);
}
