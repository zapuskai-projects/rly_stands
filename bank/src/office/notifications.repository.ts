import type { Db } from '../db/pool';

export interface OfficeNotificationRow {
  id: number;
  phone: string;
  clientName: string | null;
  channel: 'SMS' | 'PUSH';
  kind: string;
  text: string;
  operationNumber: string | null;
  createdAt: Date;
}

export interface NotificationFilter {
  phone?: string;
  kind?: string;
  channel?: string;
}

export async function listOfficeNotifications(
  db: Db,
  filter: NotificationFilter,
  limit: number,
  offset: number,
): Promise<{ rows: OfficeNotificationRow[]; total: number }> {
  const params: unknown[] = [];
  const conditions: string[] = ['(c.id IS NULL OR NOT c.technical)'];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    conditions.push(sql.replace('?', `$${params.length}`));
  };
  if (filter.phone) add('n.phone = ?', filter.phone);
  if (filter.kind) add('n.kind = ?', filter.kind);
  if (filter.channel) add('n.channel = ?', filter.channel);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const count = await db.query<{ total: bigint }>(`SELECT COUNT(*) AS total FROM notifications n LEFT JOIN clients c ON c.id = n.client_id ${where}`, params);
  const page = await db.query<{
    id: bigint;
    phone: string;
    full_name: string | null;
    channel: 'SMS' | 'PUSH';
    kind: string;
    text: string;
    operation_number: string | null;
    created_at: Date;
  }>(
    `SELECT n.id, n.phone, c.full_name, n.channel, n.kind, n.text, o.number AS operation_number, n.created_at
     FROM notifications n LEFT JOIN clients c ON c.id = n.client_id LEFT JOIN operations o ON o.id = n.operation_id
     ${where} ORDER BY n.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return {
    rows: page.rows.map((row) => ({
      id: Number(row.id),
      phone: row.phone,
      clientName: row.full_name,
      channel: row.channel,
      kind: row.kind,
      text: row.text,
      operationNumber: row.operation_number,
      createdAt: row.created_at,
    })),
    total: Number((count.rows[0] as { total: bigint }).total),
  };
}
