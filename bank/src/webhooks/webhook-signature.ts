import { createHmac } from 'node:crypto';

export const WEBHOOK_MAX_ATTEMPTS = 4;
export const WEBHOOK_RETRY_DELAYS_SEC: readonly number[] = [10, 30, 60];
export const WEBHOOK_TIMEOUT_MS = 5000;

export type WebhookEventName = 'qr.paid' | 'qr.refunded';

export interface WebhookBody {
  event: WebhookEventName;
  qrId: string;
  orderId: string;
  amount: number;
  refundedAmount: number;
  operationId: string;
  occurredAt: string;
}

export function signWebhook(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function retryDelaySec(attemptsMade: number): number | null {
  return attemptsMade >= WEBHOOK_MAX_ATTEMPTS ? null : (WEBHOOK_RETRY_DELAYS_SEC[attemptsMade - 1] ?? null);
}

export function serializeWebhook(body: WebhookBody): string {
  return JSON.stringify(body);
}
