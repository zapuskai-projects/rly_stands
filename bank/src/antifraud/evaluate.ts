import { randomUUID } from 'node:crypto';
import type { BankClock } from '../clock/bank-clock';
import { toMoscowIso } from '../clock/moscow';
import type { Db } from '../db/pool';
import type { AntifraudDecisionPayload, PaymentCreatedPayload } from '../events/payloads';
import { loadAwaitingPayment } from './facts.repository';
import { decideByScore, scorePayment } from './scoring';
import { loadThresholds } from './settings.repository';

export async function evaluatePayment(db: Db, clock: BankClock, payload: PaymentCreatedPayload): Promise<AntifraudDecisionPayload | null> {
  if (payload.type !== 'PHONE_TRANSFER') return null;
  const awaiting = await loadAwaitingPayment(db, payload.operationId);
  if (!awaiting) return null;
  const thresholds = await loadThresholds(db);
  const { score, rules } = scorePayment({ createdAt: awaiting.createdAt, amount: awaiting.amount, facts: awaiting.facts });
  return {
    eventId: randomUUID(),
    operationId: payload.operationId,
    operationNumber: payload.operationNumber,
    clientNumber: payload.clientNumber,
    score,
    decision: decideByScore(score, thresholds),
    rules,
    thresholds: { review: thresholds.review, reject: thresholds.reject },
    decidedAt: toMoscowIso(clock.now()),
  };
}
