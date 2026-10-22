import { enqueueOutbox } from '../events/outbox.repository';
import { notificationOutboxMessage } from '../events/builders';
import type { Db } from '../db/pool';
import { shortName } from '../clients/names';
import type { OperationRecord } from '../payments/operations.repository';
import { recipientTexts, senderTexts } from './texts';

interface Contact {
  id: string;
  phone: string;
  fullName: string;
}

async function loadContact(db: Db, clientId: string): Promise<Contact | null> {
  const result = await db.query<{ id: string; phone: string; full_name: string }>(
    'SELECT id, phone, full_name FROM clients WHERE id = $1',
    [clientId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, phone: row.phone, fullName: row.full_name } : null;
}

async function loadAccountOwner(db: Db, accountId: string): Promise<Contact | null> {
  const result = await db.query<{ client_id: string | null }>('SELECT client_id FROM accounts WHERE id = $1', [accountId]);
  const clientId = result.rows[0]?.client_id;
  return clientId ? loadContact(db, clientId) : null;
}

async function queuePair(db: Db, operation: OperationRecord, contact: Contact, kind: 'TRANSFER_COMPLETED' | 'TRANSFER_RECEIVED', texts: { sms: string; push: string }, at: Date) {
  for (const [channel, text] of [['SMS', texts.sms], ['PUSH', texts.push]] as const) {
    await enqueueOutbox(
      db,
      notificationOutboxMessage({
        operationId: operation.id,
        requestId: operation.requestId ?? 'unknown',
        clientId: contact.id,
        phone: contact.phone,
        channel,
        kind,
        text,
        createdAt: at,
      }),
    );
  }
}

export async function queueCompletionNotifications(db: Db, operation: OperationRecord, at: Date): Promise<void> {
  const sender = await loadContact(db, operation.clientId);
  if (!sender) return;
  const facts = {
    type: operation.type,
    amount: operation.amount,
    operationNumber: operation.number,
    recipientName: operation.recipientName,
    recipientPhone: operation.recipientPhone,
    recipientBankName: operation.recipientBankName,
    senderShortName: shortName(sender.fullName),
  };
  await queuePair(db, operation, sender, 'TRANSFER_COMPLETED', senderTexts(facts), at);
  if (operation.type === 'PHONE_TRANSFER' && operation.route === 'INTERNAL' && operation.toAccountId) {
    const recipient = await loadAccountOwner(db, operation.toAccountId);
    if (recipient) await queuePair(db, operation, recipient, 'TRANSFER_RECEIVED', recipientTexts(facts), at);
  }
}
