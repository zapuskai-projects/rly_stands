import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import type { BackgroundLoop } from '../events/outbox.publisher';
import { logger } from '../shared/logger';
import { retryDelaySec, signWebhook } from './webhook-signature';
import type { WebhookSender } from './webhook-sender';
import { loadActiveDefects } from '../defects/defects.repository';
import { claimDueDeliveries, recordAttempt, type DeliveryMark, type DeliveryRecord } from './webhooks.repository';

const CLAIM_BATCH = 10;
const LEASE_MS = 15_000;
const LOOP_INTERVAL_MS = 1000;

export interface WebhookDeps {
  pool: Pool;
  clock: BankClock;
  send: WebhookSender;
  realNow?: () => Date;
}

async function deliverOne(deps: WebhookDeps, delivery: DeliveryRecord, realNow: () => Date, noRetry: boolean): Promise<void> {
  const startedAt = Date.now();
  const at = deps.clock.now();
  const answer = await deps.send({
    url: delivery.url,
    headers: {
      'Content-Type': 'application/json',
      'X-Signature': signWebhook(delivery.secret, delivery.body),
      'X-Event-Id': delivery.eventId,
      'User-Agent': 'ZapuskBank-Webhook/1.0',
    },
    body: delivery.body,
  });
  const durationMs = Date.now() - startedAt;
  const delivered = answer.kind === 'RESPONSE' && answer.status >= 200 && answer.status < 300;
  const attemptsMade = delivery.attemptsMade + 1;
  const correctDelay = delivered ? null : retryDelaySec(attemptsMade);
  const delay = noRetry ? null : correctDelay;
  const status = delivered ? 'DELIVERED' : delay === null ? 'FAILED' : 'PENDING';
  const next = {
    status: status as 'DELIVERED' | 'FAILED' | 'PENDING',
    nextAttemptAt: delay === null ? null : new Date(realNow().getTime() + delay * 1000),
    finishedAt: status === 'PENDING' ? null : at,
  };
  const mark: DeliveryMark | undefined =
    noRetry && correctDelay !== null
      ? {
          code: 'webhook-no-retry',
          details: {
            expected: 'RETRY',
            actual: 'FAILED',
            attempt: attemptsMade,
            statusCode: answer.kind === 'RESPONSE' ? answer.status : null,
            error: answer.kind === 'ERROR' ? answer.error : null,
            retryExpectedInSec: correctDelay,
          },
        }
      : undefined;
  await recordAttempt(
    deps.pool,
    delivery,
    { at, statusCode: answer.kind === 'RESPONSE' ? answer.status : null, error: answer.kind === 'ERROR' ? answer.error : null, durationMs },
    next,
    mark,
  );
  logger.info('webhook attempt', {
    eventId: delivery.eventId,
    event: delivery.event,
    attempt: attemptsMade,
    result: answer.kind === 'RESPONSE' ? answer.status : answer.error,
    status,
  });
}

export async function dispatchDueWebhooks(deps: WebhookDeps): Promise<number> {
  const realNow = deps.realNow ?? (() => new Date());
  const claimed = await claimDueDeliveries(deps.pool, realNow(), LEASE_MS, CLAIM_BATCH);
  const noRetry = claimed.length > 0 && (await loadActiveDefects(deps.pool)).has('webhook-no-retry');
  await Promise.all(
    claimed.map((delivery) =>
      deliverOne(deps, delivery, realNow, noRetry).catch((error: unknown) => {
        logger.warn('webhook attempt not recorded', { eventId: delivery.eventId, error: error instanceof Error ? error.message : String(error) });
      }),
    ),
  );
  return claimed.length;
}

export function startWebhookDispatcher(deps: WebhookDeps): BackgroundLoop {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        await dispatchDueWebhooks(deps);
      } catch (error) {
        logger.warn('webhook dispatcher cycle failed', { error: error instanceof Error ? error.message : String(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, LOOP_INTERVAL_MS));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
    },
  };
}
