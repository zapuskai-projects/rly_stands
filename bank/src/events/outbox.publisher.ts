import type { Pool } from 'pg';
import { withTransaction } from '../db/pool';
import { logger } from '../shared/logger';
import { claimOutboxBatch, markOutboxFailed, markOutboxPublished, type OutboxRecord } from './outbox.repository';

export interface EventTransport {
  send(record: OutboxRecord): Promise<void>;
}

const BATCH_SIZE = 50;
const MAX_BACKOFF_MS = 5000;

export interface PublishResult {
  published: number;
  failed: boolean;
}

export async function publishPending(pool: Pool, transport: EventTransport): Promise<PublishResult> {
  return withTransaction(pool, async (tx) => {
    const batch = await claimOutboxBatch(tx, BATCH_SIZE);
    const result: PublishResult = { published: 0, failed: false };
    for (const record of batch) {
      try {
        await transport.send(record);
        await markOutboxPublished(tx, record.id);
        result.published += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markOutboxFailed(tx, record.id, message);
        logger.warn('outbox publish failed', {
          outboxId: record.id,
          topic: record.topic,
          operationId: record.headers.operationId,
          requestId: record.headers.requestId,
          error: message,
        });
        result.failed = true;
        break;
      }
    }
    return result;
  });
}

export interface BackgroundLoop {
  stop(): Promise<void>;
}

export function startOutboxPublisher(pool: Pool, transport: EventTransport, intervalMs = 250): BackgroundLoop {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    let failures = 0;
    while (!stopped) {
      let idleMs = 0;
      try {
        const result = await publishPending(pool, transport);
        failures = result.failed ? failures + 1 : 0;
        if (result.failed) idleMs = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures);
        else if (result.published === 0) idleMs = intervalMs;
      } catch (error) {
        failures += 1;
        idleMs = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures);
        logger.warn('outbox cycle failed', { error: error instanceof Error ? error.message : String(error) });
      }
      if (idleMs > 0) await new Promise((resolve) => setTimeout(resolve, idleMs));
    }
  };
  running = tick();
  return {
    async stop() {
      stopped = true;
      await running;
    },
  };
}
