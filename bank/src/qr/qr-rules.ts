import { createHash } from 'node:crypto';
import { mulDivRoundHalfUp, type Kopecks } from '../accounts/money';

export const QR_STATUSES = ['CREATED', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'EXPIRED', 'CANCELLED'] as const;

export type QrStatus = (typeof QR_STATUSES)[number];

export const QR_PAYLOAD_PREFIX = 'zbqr://pay?id=';

export const QR_DEFAULT_TTL_SECONDS = 600;

const PAYLOAD_PATTERN = /^zbqr:\/\/pay\?id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const BASIS_POINTS_IN_WHOLE = 10_000n;

export interface QrState {
  status: QrStatus;
  expiresAt: Date;
  pendingOperationId: string | null;
}

export interface QrRefusal {
  status: 409;
  code: 'QR_EXPIRED' | 'QR_ALREADY_PAID' | 'QR_CANCELLED';
  message: string;
}

export function buildQrPayload(qrId: string): string {
  return `${QR_PAYLOAD_PREFIX}${qrId}`;
}

export function parseQrPayload(payload: string): string | null {
  const match = PAYLOAD_PATTERN.exec(payload.trim());
  return match ? (match[1] as string).toLowerCase() : null;
}

export function qrExpiresAt(createdAt: Date, ttlSeconds: number): Date {
  return new Date(createdAt.getTime() + ttlSeconds * 1000);
}

export function effectiveQrStatus(qr: QrState, now: Date): QrStatus {
  if (qr.status === 'CREATED' && qr.pendingOperationId === null && now.getTime() >= qr.expiresAt.getTime()) return 'EXPIRED';
  return qr.status;
}

export function paymentRefusal(qr: QrState, now: Date): QrRefusal | null {
  const status = effectiveQrStatus(qr, now);
  if (status === 'CANCELLED') return { status: 409, code: 'QR_CANCELLED', message: 'QR-код отменён магазином' };
  if (status === 'EXPIRED') return { status: 409, code: 'QR_EXPIRED', message: 'Срок действия QR-кода истёк' };
  if (status !== 'CREATED') return { status: 409, code: 'QR_ALREADY_PAID', message: 'QR-код уже оплачен' };
  if (qr.pendingOperationId !== null) return { status: 409, code: 'QR_ALREADY_PAID', message: 'Оплата этого QR-кода уже выполняется' };
  return null;
}

export interface QrPaymentDefects {
  doublePayment: boolean;
  expiredAccepted: boolean;
}

export interface QrPaymentDecision {
  refusal: QrRefusal | null;
  defect: { code: 'qr-double-payment' | 'qr-expired-accepted'; expected: QrRefusal['code'] } | null;
}

export function paymentDecision(qr: QrState, now: Date, flags: QrPaymentDefects): QrPaymentDecision {
  const correct = paymentRefusal(qr, now);
  if (correct?.code === 'QR_ALREADY_PAID' && flags.doublePayment) return { refusal: null, defect: { code: 'qr-double-payment', expected: correct.code } };
  if (correct?.code === 'QR_EXPIRED' && flags.expiredAccepted) return { refusal: null, defect: { code: 'qr-expired-accepted', expected: correct.code } };
  return { refusal: correct, defect: null };
}

export function cancelRefusal(qr: QrState, now: Date): QrRefusal | null {
  const status = effectiveQrStatus(qr, now);
  if (status === 'CANCELLED') return null;
  if (status === 'EXPIRED') return { status: 409, code: 'QR_EXPIRED', message: 'Срок действия QR-кода истёк, отменять нечего' };
  if (status !== 'CREATED') return { status: 409, code: 'QR_ALREADY_PAID', message: 'QR-код уже оплачен, отменить его нельзя' };
  if (qr.pendingOperationId !== null) return { status: 409, code: 'QR_ALREADY_PAID', message: 'По QR-коду идёт оплата, отменить его нельзя' };
  return null;
}

export function merchantCommission(amount: Kopecks, commissionBps: number): Kopecks {
  return mulDivRoundHalfUp(amount, BigInt(commissionBps), BASIS_POINTS_IN_WHOLE);
}

export function hashQrPayment(qrId: string, accountId: string): string {
  return createHash('sha256').update(JSON.stringify(['QR_PAYMENT', qrId, accountId])).digest('hex');
}

export function hashQrRefund(qrId: string, amount: Kopecks): string {
  return createHash('sha256').update(JSON.stringify(['QR_REFUND', qrId, amount.toString()])).digest('hex');
}

export function refundableAmount(qr: { amount: Kopecks; refunded: Kopecks }): Kopecks {
  return qr.amount - qr.refunded;
}

export function isPaidStatus(status: QrStatus): boolean {
  return status === 'PAID' || status === 'PARTIALLY_REFUNDED';
}
