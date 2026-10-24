import type { Pool } from 'pg';
import { toApiAmount } from '../accounts/money';
import { toMoscowIso } from '../clock/moscow';
import type { BankClock } from '../clock/bank-clock';
import { webhookDeliveryDto } from '../api/dto-qr';
import { listQrCodes, type QrFilter } from '../qr/qr.repository';
import { listQrRefunds } from '../qr/qr-refunds.repository';
import { effectiveQrStatus } from '../qr/qr-rules';
import { signWebhook, type WebhookEventName } from '../webhooks/webhook-signature';
import { listDeliveries, listDeliveryMarks } from '../webhooks/webhooks.repository';

const QR_LIMIT = 200;

export async function listQrFacts(db: Pool, clock: BankClock, filter: QrFilter) {
  const codes = await listQrCodes(db, filter, QR_LIMIT);
  const refunds = await listQrRefunds(db, codes.map((code) => code.id));
  const payers = await db.query<{ id: string; phone: string }>(
    'SELECT o.id, c.phone FROM operations o JOIN clients c ON c.id = o.client_id WHERE o.id = ANY($1::uuid[])',
    [codes.flatMap((code) => (code.paidOperationId ? [code.paidOperationId] : []))],
  );
  const now = clock.now();
  return codes.map((code) => {
    const status = effectiveQrStatus(code, now);
    const paid = code.paidOperationId !== null;
    return {
      id: code.id,
      orderId: code.orderId,
      status,
      description: code.description,
      amountKop: toApiAmount(code.amount),
      commissionKop: toApiAmount(code.commission),
      creditedKop: paid ? toApiAmount(code.amount - code.commission) : 0,
      refundedKop: toApiAmount(code.refunded),
      remainingKop: paid ? Math.max(0, toApiAmount(code.amount - code.refunded)) : 0,
      operationId: code.paidOperationId,
      operationNumber: code.paidOperationNumber,
      payerPhone: payers.rows.find((row) => row.id === code.paidOperationId)?.phone ?? null,
      createdAt: toMoscowIso(code.createdAt),
      expiresAt: toMoscowIso(code.expiresAt),
      paidAt: code.paidAt ? toMoscowIso(code.paidAt) : null,
      refunds: (refunds.get(code.id) ?? []).map((refund) => ({
        id: refund.id,
        operationId: refund.operationId,
        operationNumber: refund.operationNumber,
        amountKop: toApiAmount(refund.amount),
        createdAt: toMoscowIso(refund.createdAt),
      })),
    };
  });
}

export interface DeliveryFactFilter {
  label?: string;
  qrId?: string;
  event?: WebhookEventName;
}

export async function listDeliveryFacts(db: Pool, clock: BankClock, filter: DeliveryFactFilter) {
  const { rows } = await listDeliveries(db, filter, QR_LIMIT, 0);
  const offsetMs = clock.getOffsetMs();
  const marks = await listDeliveryMarks(db, rows.map((row) => row.eventId));
  return rows
    .map((row) => ({
      ...webhookDeliveryDto(row, offsetMs),
      body: JSON.parse(row.body) as unknown,
      signature: signWebhook(row.secret, row.body),
      defects: marks.get(row.eventId) ?? [],
    }))
    .reverse();
}
