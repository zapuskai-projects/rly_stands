import type { Pool } from 'pg';
import { z } from 'zod';
import type { BankClock } from '../clock/bank-clock';
import { withTransaction } from '../db/pool';
import { beginProcessing, rejectOperation, requireLockedOperation } from '../payments/lifecycle';
import { transitionOperation } from '../payments/operations.repository';
import { reviewDeadline } from '../review/deadline';
import { insertManualReview } from '../review/review.repository';

const decisionSchema = z.object({
  eventId: z.string(),
  operationId: z.string().uuid(),
  operationNumber: z.string(),
  clientNumber: z.string(),
  score: z.number().int().min(0),
  decision: z.enum(['APPROVE', 'REVIEW', 'REJECT']),
  rules: z.array(z.object({ code: z.string(), points: z.number().int() })),
  thresholds: z.object({ review: z.number().int(), reject: z.number().int() }),
  decidedAt: z.string(),
});

export type DecisionOutcome = 'APPLIED' | 'IGNORED';

export interface DecisionDeps {
  pool: Pool;
  clock: BankClock;
}

export async function applyAntifraudDecision(deps: DecisionDeps, raw: unknown, requestId: string): Promise<DecisionOutcome> {
  const decision = decisionSchema.parse(raw);
  const context = { clock: deps.clock, requestId };
  return withTransaction(deps.pool, async (tx): Promise<DecisionOutcome> => {
    const operation = await requireLockedOperation(tx, decision.operationId);
    if (operation.status !== 'CHECKING') return 'IGNORED';
    const now = deps.clock.now();
    await tx.query(
      `INSERT INTO antifraud_decisions (operation_id, score, decision, rules, review_threshold, reject_threshold, decided_at, applied_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        decision.operationId,
        decision.score,
        decision.decision,
        JSON.stringify(decision.rules),
        decision.thresholds.review,
        decision.thresholds.reject,
        decision.decidedAt,
        now,
      ],
    );
    if (decision.decision === 'APPROVE') {
      await beginProcessing(tx, context, operation);
    } else if (decision.decision === 'REVIEW') {
      await transitionOperation(tx, operation.id, 'ON_REVIEW', {
        at: now,
        requestId,
        reasonCode: 'ANTIFRAUD_REVIEW',
        comment: `Оценка антифрода ${decision.score}: нужна ручная проверка`,
      });
      await insertManualReview(tx, operation.id, reviewDeadline(now), now);
    } else {
      await rejectOperation(tx, context, operation, {
        code: 'ANTIFRAUD_REJECTED',
        message: `Антифрод отклонил перевод: оценка ${decision.score}`,
      });
    }
    return 'APPLIED';
  });
}
