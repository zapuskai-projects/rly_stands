import { toApiAmount } from '../accounts/money';
import { toMoscowIso } from '../clock/moscow';
import type { RefundResult } from '../qr/qr-refund.service';
import type { QrRecord } from '../qr/qr.repository';
import type { DeliveryRecord } from '../webhooks/webhooks.repository';
import { buildQrPayload, effectiveQrStatus, type QrStatus } from '../qr/qr-rules';

const PAID_STATUSES: readonly QrStatus[] = ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'];

export const partnerQrDto = (qr: QrRecord, now: Date) => {
  const status = effectiveQrStatus(qr, now);
  return {
    qrId: qr.id,
    orderId: qr.orderId,
    payload: buildQrPayload(qr.id),
    status,
    amount: toApiAmount(qr.amount),
    description: qr.description,
    paidAmount: PAID_STATUSES.includes(status) ? toApiAmount(qr.amount) : 0,
    refundedAmount: toApiAmount(qr.refunded),
    operationId: qr.paidOperationId,
    operationNumber: qr.paidOperationNumber,
    paidAt: qr.paidAt ? toMoscowIso(qr.paidAt) : null,
    createdAt: toMoscowIso(qr.createdAt),
    expiresAt: toMoscowIso(qr.expiresAt),
  };
};

export const qrPurchaseDto = (qr: QrRecord, now: Date) => ({
  qrId: qr.id,
  merchant: qr.partnerName,
  amount: toApiAmount(qr.amount),
  description: qr.description,
  status: effectiveQrStatus(qr, now),
  expiresAt: toMoscowIso(qr.expiresAt),
});

export const partnerRefundDto = ({ refund, qr }: RefundResult) => ({
  refundId: refund.id,
  qrId: qr.id,
  orderId: qr.orderId,
  operationId: refund.operationId,
  operationNumber: refund.operationNumber,
  amount: toApiAmount(refund.amount),
  refundedAmount: toApiAmount(qr.refunded),
  qrStatus: qr.status,
  createdAt: toMoscowIso(refund.createdAt),
});

export const webhookDeliveryDto = (delivery: DeliveryRecord, bankOffsetMs: number) => ({
  eventId: delivery.eventId,
  event: delivery.event,
  qrId: delivery.qrId,
  orderId: delivery.orderId,
  operationId: delivery.operationId,
  url: delivery.url,
  status: delivery.status,
  attemptsMade: delivery.attemptsMade,
  attempts: delivery.attempts.map((attempt) => ({
    attempt: attempt.attempt,
    at: toMoscowIso(attempt.at),
    statusCode: attempt.statusCode,
    error: attempt.error,
    durationMs: attempt.durationMs,
  })),
  nextAttemptAt:
    delivery.status !== 'PENDING' || delivery.nextAttemptAt === null
      ? null
      : toMoscowIso(delivery.attemptsMade === 0 ? delivery.createdAt : new Date(delivery.nextAttemptAt.getTime() + bankOffsetMs)),
  createdAt: toMoscowIso(delivery.createdAt),
});
