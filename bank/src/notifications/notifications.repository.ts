import type { Db } from '../db/pool';

export type NotificationChannel = 'SMS' | 'PUSH';

export interface NewNotification {
  clientId: string | null;
  phone: string;
  channel: NotificationChannel;
  kind: string;
  text: string;
  operationId?: string | null;
  messageId?: string | null;
  createdAt: Date;
}

export interface NotificationRecord {
  id: number;
  phone: string;
  channel: NotificationChannel;
  kind: string;
  text: string;
  createdAt: Date;
}

export async function insertNotification(db: Db, input: NewNotification): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO notifications (client_id, phone, channel, kind, text, operation_id, message_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (message_id) DO NOTHING`,
    [input.clientId, input.phone, input.channel, input.kind, input.text, input.operationId ?? null, input.messageId ?? null, input.createdAt],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listNotificationsByPhone(db: Db, phone: string, limit: number): Promise<NotificationRecord[]> {
  const result = await db.query<{
    id: bigint;
    phone: string;
    channel: NotificationChannel;
    kind: string;
    text: string;
    created_at: Date;
  }>('SELECT id, phone, channel, kind, text, created_at FROM notifications WHERE phone = $1 ORDER BY id DESC LIMIT $2', [
    phone,
    limit,
  ]);
  return result.rows.map((row) => ({
    id: Number(row.id),
    phone: row.phone,
    channel: row.channel,
    kind: row.kind,
    text: row.text,
    createdAt: row.created_at,
  }));
}
