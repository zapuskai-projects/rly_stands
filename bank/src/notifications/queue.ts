import { notificationOutboxMessage } from '../events/builders';
import type { NotificationKind } from '../events/payloads';
import { enqueueOutbox } from '../events/outbox.repository';
import type { Db } from '../db/pool';
import type { ChannelTexts } from './texts';

export interface Contact {
  id: string;
  phone: string;
  fullName: string;
}

export async function loadContact(db: Db, clientId: string): Promise<Contact | null> {
  const result = await db.query<{ id: string; phone: string; full_name: string }>(
    'SELECT id, phone, full_name FROM clients WHERE id = $1',
    [clientId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, phone: row.phone, fullName: row.full_name } : null;
}

export interface QueuedPair {
  operationId: string | null;
  autopaymentId?: string;
  requestId: string;
  contact: Contact;
  kind: NotificationKind;
  texts: ChannelTexts;
  at: Date;
}

export async function queuePair(db: Db, pair: QueuedPair): Promise<void> {
  for (const [channel, text] of [['SMS', pair.texts.sms], ['PUSH', pair.texts.push]] as const) {
    await enqueueOutbox(
      db,
      notificationOutboxMessage({
        operationId: pair.operationId,
        autopaymentId: pair.autopaymentId,
        requestId: pair.requestId,
        clientId: pair.contact.id,
        phone: pair.contact.phone,
        channel,
        kind: pair.kind,
        text,
        createdAt: pair.at,
      }),
    );
  }
}
