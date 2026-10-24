import type { Pool } from 'pg';
import { z, ZodError } from 'zod';
import { evaluatePayment } from '../antifraud/evaluate';
import { applyAntifraudDecision, type DecisionDeps } from '../antifraud/decision.service';
import type { BankClock } from '../clock/bank-clock';
import { deliverNotification } from '../notifications/delivery';
import { describeError } from '../shared/errors';
import { logger } from '../shared/logger';
import { SkippableMessageError, type KafkaMessageView, parseJsonMessage } from './kafka';
import type { AntifraudDecisionPayload, PaymentCreatedPayload } from './payloads';

export interface HandlerDeps {
  pool: Pool;
  clock: BankClock;
}

const createdSchema = z.object({
  operationId: z.string().uuid(),
  operationNumber: z.string(),
  clientNumber: z.string(),
  type: z.enum(['OWN_TRANSFER', 'PHONE_TRANSFER', 'QR_PAYMENT', 'QR_REFUND']),
  amount: z.number().positive(),
});

function isSkippable(error: unknown): boolean {
  return error instanceof SkippableMessageError || error instanceof ZodError;
}

export async function handleDecisionMessage(deps: DecisionDeps, message: KafkaMessageView): Promise<void> {
  const requestId = message.headers.requestId ?? 'unknown';
  try {
    const outcome = await applyAntifraudDecision(deps, parseJsonMessage(message), requestId);
    logger.info('antifraud decision handled', { operationId: message.headers.operationId, requestId, outcome });
  } catch (error) {
    if (!isSkippable(error)) throw error;
    logger.error('antifraud decision skipped', { operationId: message.headers.operationId, requestId, error: describeError(error) });
  }
}

export type DecisionSender = (decision: AntifraudDecisionPayload, headers: Record<string, string>) => Promise<void>;

export async function handleCreatedMessage(deps: HandlerDeps, send: DecisionSender, message: KafkaMessageView): Promise<void> {
  const requestId = message.headers.requestId ?? 'unknown';
  try {
    const raw = parseJsonMessage(message);
    createdSchema.parse(raw);
    const payload = raw as PaymentCreatedPayload;
    const decision = await evaluatePayment(deps.pool, deps.clock, payload);
    if (!decision) {
      logger.info('payment is not scored', { operationId: payload.operationId, requestId });
      return;
    }
    await send(decision, { operationId: decision.operationId, requestId });
    logger.info('antifraud decision published', {
      operationId: decision.operationId,
      requestId,
      score: decision.score,
      decision: decision.decision,
      rules: decision.rules.map((rule) => rule.code),
    });
  } catch (error) {
    if (!isSkippable(error)) throw error;
    logger.error('payment event skipped', { operationId: message.headers.operationId, requestId, error: describeError(error) });
  }
}

export async function handleNotificationMessage(deps: HandlerDeps, body: string, headers: Record<string, string>): Promise<void> {
  const result = await deliverNotification(deps.pool, deps.clock, JSON.parse(body) as unknown);
  logger.info('notification handled', { operationId: headers.operationId, requestId: headers.requestId, result });
}
