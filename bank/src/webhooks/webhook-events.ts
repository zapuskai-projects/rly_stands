import { randomUUID } from 'node:crypto';
import { toApiAmount } from '../accounts/money';
import { toMoscowIso } from '../clock/moscow';
import type { Db } from '../db/pool';
import type { Partner } from '../partners/partners.repository';
import type { QrRecord } from '../qr/qr.repository';
import { serializeWebhook, type WebhookEventName } from './webhook-signature';
import { insertDelivery } from './webhooks.repository';

export interface QrWebhookEvent {
  partner: Partner;
  event: WebhookEventName;
  qr: Pick<QrRecord, 'id' | 'orderId' | 'amount' | 'refunded'>;
  operationId: string;
  at: Date;
}

export async function enqueueQrWebhook(db: Db, input: QrWebhookEvent): Promise<string | null> {
  if (!input.partner.webhookUrl || !input.partner.webhookSecret) return null;
  const eventId = randomUUID();
  await insertDelivery(db, {
    eventId,
    partnerId: input.partner.id,
    event: input.event,
    qrId: input.qr.id,
    operationId: input.operationId,
    url: input.partner.webhookUrl,
    secret: input.partner.webhookSecret,
    body: serializeWebhook({
      event: input.event,
      qrId: input.qr.id,
      orderId: input.qr.orderId,
      amount: toApiAmount(input.qr.amount),
      refundedAmount: toApiAmount(input.qr.refunded),
      operationId: input.operationId,
      occurredAt: toMoscowIso(input.at),
    }),
    nextAttemptAt: new Date(0),
    createdAt: input.at,
  });
  return eventId;
}
