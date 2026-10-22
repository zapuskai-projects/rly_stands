import { z } from 'zod';
import type { BankClock } from '../clock/bank-clock';
import type { Db } from '../db/pool';
import { insertNotification } from './notifications.repository';

const messageSchema = z.object({
  messageId: z.string().uuid(),
  operationId: z.string().uuid(),
  clientId: z.string().uuid(),
  phone: z.string().regex(/^\+79[0-9]{9}$/),
  channel: z.enum(['SMS', 'PUSH']),
  kind: z.enum(['TRANSFER_COMPLETED', 'TRANSFER_RECEIVED']),
  text: z.string().min(1).max(1000),
  createdAt: z.string(),
});

export type DeliveryResult = 'DELIVERED' | 'DUPLICATE';

export async function deliverNotification(db: Db, clock: BankClock, raw: unknown): Promise<DeliveryResult> {
  const message = messageSchema.parse(raw);
  const inserted = await insertNotification(db, {
    clientId: message.clientId,
    phone: message.phone,
    channel: message.channel,
    kind: message.kind,
    text: message.text,
    operationId: message.operationId,
    messageId: message.messageId,
    createdAt: clock.now(),
  });
  return inserted ? 'DELIVERED' : 'DUPLICATE';
}
