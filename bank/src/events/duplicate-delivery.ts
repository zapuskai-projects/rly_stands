import type { DefectCode, DefectMark } from '../defects/catalog';
import type { OutboxRecord } from './outbox.repository';
import type { PaymentCreatedPayload } from './payloads';
import { getTopics } from './topics';

export const DUPLICATE_DELIVERY: DefectCode = 'events.duplicate-delivery';

const NUMBER_TAIL = /(\d)$/;

export function isRepeatedOperation(operationNumber: string): boolean {
  const last = NUMBER_TAIL.exec(operationNumber);
  return last !== null && Number(last[1]) % 2 === 1;
}

export function isDuplicationCandidate(record: OutboxRecord): boolean {
  const topics = getTopics();
  return record.destination === 'KAFKA' && (record.topic === topics.paymentsCreated || record.topic === topics.statusChanged);
}

export function shouldDeliverTwice(record: OutboxRecord): boolean {
  if (!isDuplicationCandidate(record)) return false;
  const payload = record.payload as Pick<PaymentCreatedPayload, 'operationNumber'>;
  return typeof payload.operationNumber === 'string' && isRepeatedOperation(payload.operationNumber);
}

export function duplicateDeliveryMark(record: OutboxRecord): DefectMark {
  const payload = record.payload as { eventId?: string };
  return { code: DUPLICATE_DELIVERY, details: { topic: record.topic, eventId: payload.eventId ?? null, deliveries: 2 } };
}
