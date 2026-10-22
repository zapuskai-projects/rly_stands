import type { Db } from '../db/pool';
import type { AntifraudDecision, RuleHit } from '../events/payloads';

export interface StoredDecision {
  score: number;
  decision: AntifraudDecision;
  rules: RuleHit[];
  reviewThreshold: number;
  rejectThreshold: number;
  decidedAt: Date;
}

export async function findDecision(db: Db, operationId: string): Promise<StoredDecision | null> {
  const result = await db.query<{
    score: number;
    decision: AntifraudDecision;
    rules: RuleHit[];
    review_threshold: number;
    reject_threshold: number;
    decided_at: Date;
  }>(
    'SELECT score, decision, rules, review_threshold, reject_threshold, decided_at FROM antifraud_decisions WHERE operation_id = $1',
    [operationId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    score: row.score,
    decision: row.decision,
    rules: row.rules,
    reviewThreshold: row.review_threshold,
    rejectThreshold: row.reject_threshold,
    decidedAt: row.decided_at,
  };
}
