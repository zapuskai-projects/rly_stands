import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import { withTransaction, type Db } from '../db/pool';
import { beginProcessing, rejectOperation, requireLockedOperation, type LifecycleContext } from '../payments/lifecycle';
import { lockOperation, type OperationRecord } from '../payments/operations.repository';
import { conflict, notFound } from '../shared/errors';
import { logger } from '../shared/logger';
import { isReviewOverdue } from './deadline';
import { findReviewItem, listOverdueReviewIds, lockReview, resolveReview, type ReviewItem } from './review.repository';

export interface ReviewDeps {
  pool: Pool;
  clock: BankClock;
}

type Outcome = 'DONE' | 'NOT_FOUND' | 'NOT_PENDING' | 'EXPIRED';

const OVERDUE_BATCH = 20;
const EXPIRED_COMMENT = 'Срок ручной проверки истёк';

async function expire(tx: Db, context: LifecycleContext, operationId: string): Promise<void> {
  const operation = await requireLockedOperation(tx, operationId);
  await resolveReview(tx, operationId, 'EXPIRED', context.clock.now(), 'SYSTEM', EXPIRED_COMMENT);
  await rejectOperation(tx, context, operation, { code: 'REVIEW_EXPIRED', message: EXPIRED_COMMENT });
}

async function resolveByOperator(
  deps: ReviewDeps,
  operationId: string,
  operator: string,
  requestId: string,
  decide: (tx: Db, context: LifecycleContext, operation: OperationRecord) => Promise<void>,
): Promise<Outcome> {
  const context: LifecycleContext = { clock: deps.clock, requestId, actor: `OPERATOR:${operator}` };
  return withTransaction(deps.pool, async (tx): Promise<Outcome> => {
    const operation = await lockOperation(tx, operationId);
    if (!operation) return 'NOT_FOUND';
    const review = await lockReview(tx, operationId);
    if (!review) return 'NOT_FOUND';
    if (review.state !== 'PENDING' || operation.status !== 'ON_REVIEW') return 'NOT_PENDING';
    if (isReviewOverdue(review.deadlineAt, deps.clock.now())) {
      await expire(tx, { clock: deps.clock, requestId }, operationId);
      return 'EXPIRED';
    }
    await decide(tx, context, operation);
    return 'DONE';
  });
}

async function finish(deps: ReviewDeps, operationId: string, outcome: Outcome): Promise<ReviewItem> {
  if (outcome === 'NOT_FOUND') throw notFound('REVIEW_NOT_FOUND', 'Проверки по этой операции нет');
  if (outcome === 'NOT_PENDING') throw conflict('REVIEW_ALREADY_RESOLVED', 'Проверка по операции уже завершена');
  if (outcome === 'EXPIRED') throw conflict('REVIEW_EXPIRED', 'Срок проверки истёк, перевод отклонён, средства разморожены');
  return (await findReviewItem(deps.pool, operationId)) as ReviewItem;
}

export async function approveReview(
  deps: ReviewDeps,
  operationId: string,
  operator: string,
  comment: string | null,
  requestId: string,
): Promise<ReviewItem> {
  const outcome = await resolveByOperator(deps, operationId, operator, requestId, async (tx, context, operation) => {
    await resolveReview(tx, operationId, 'APPROVED', deps.clock.now(), operator, comment);
    await beginProcessing(tx, context, operation);
  });
  return finish(deps, operationId, outcome);
}

export async function rejectReview(
  deps: ReviewDeps,
  operationId: string,
  operator: string,
  comment: string,
  requestId: string,
): Promise<ReviewItem> {
  const outcome = await resolveByOperator(deps, operationId, operator, requestId, async (tx, context, operation) => {
    await resolveReview(tx, operationId, 'REJECTED', deps.clock.now(), operator, comment);
    await rejectOperation(tx, context, operation, { code: 'OPERATOR_REJECTED', message: comment });
  });
  return finish(deps, operationId, outcome);
}

export async function expireOverdueReviews(deps: ReviewDeps): Promise<number> {
  const ids = await listOverdueReviewIds(deps.pool, deps.clock.now(), OVERDUE_BATCH);
  let expired = 0;
  for (const operationId of ids) {
    const requestId = `review-expiry-${operationId.slice(0, 8)}`;
    const done = await withTransaction(deps.pool, async (tx) => {
      const operation = await requireLockedOperation(tx, operationId);
      const review = await lockReview(tx, operationId);
      if (!review || review.state !== 'PENDING' || operation.status !== 'ON_REVIEW') return false;
      if (!isReviewOverdue(review.deadlineAt, deps.clock.now())) return false;
      await expire(tx, { clock: deps.clock, requestId }, operationId);
      return true;
    });
    if (done) {
      expired += 1;
      logger.info('review expired', { operationId, requestId });
    }
  }
  return expired;
}
