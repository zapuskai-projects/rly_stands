import type { Db } from '../db/pool';
import { shortName } from '../clients/names';
import type { OperationRecord } from '../payments/operations.repository';
import { loadContact, queuePair } from './queue';
import { recipientTexts, senderTexts } from './texts';

async function loadAccountOwner(db: Db, accountId: string) {
  const result = await db.query<{ client_id: string | null }>('SELECT client_id FROM accounts WHERE id = $1', [accountId]);
  const clientId = result.rows[0]?.client_id;
  return clientId ? loadContact(db, clientId) : null;
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
  const requestId = operation.requestId ?? 'unknown';
  await queuePair(db, { operationId: operation.id, requestId, contact: sender, kind: 'TRANSFER_COMPLETED', texts: senderTexts(facts), at });
  if (operation.type === 'PHONE_TRANSFER' && operation.route === 'INTERNAL' && operation.toAccountId) {
    const recipient = await loadAccountOwner(db, operation.toAccountId);
    if (recipient) await queuePair(db, { operationId: operation.id, requestId, contact: recipient, kind: 'TRANSFER_RECEIVED', texts: recipientTexts(facts), at });
  }
}
