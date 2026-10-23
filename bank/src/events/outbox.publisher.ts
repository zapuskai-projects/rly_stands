import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import { withTransaction } from '../db/pool';
import { insertDefectMarks, loadActiveDefects } from '../defects/defects.repository';
import { logger } from '../shared/logger';
import { DUPLICATE_DELIVERY, duplicateDeliveryMark, shouldDeliverTwice } from './duplicate-delivery';
import { claimOutboxBatch, markOutboxFailed, markOutboxPublished, type OutboxRecord } from './outbox.repository';
import { isStatusChangedRecord, observeStatusChange, type StatusObservation } from './status-observation';

export interface EventTransport {
  send(record: OutboxRecord): Promise<void>;
}

export interface PublishOptions {
  clock?: BankClock;
  onStatusChanged?: (observation: StatusObservation) => void;
}

const BATCH_SIZE = 50;
const MAX_BACKOFF_MS = 5000;

export interface PublishResult {
  published: number;
  failed: boolean;
}

export async function publishPending(pool: Pool, transport: EventTransport, options: PublishOptions = {}): Promise<PublishResult> {
  const observations: StatusObservation[] = [];
  const result = await withTransaction(pool, async (tx) => {
    const batch = await claimOutboxBatch(tx, BATCH_SIZE);
    const outcome: PublishResult = { published: 0, failed: false };
    const repeating = batch.some(shouldDeliverTwice) && (await loadActiveDefects(tx)).has(DUPLICATE_DELIVERY);
    for (const record of batch) {
      let sent = false;
      try {
        await transport.send(record);
        if (repeating && shouldDeliverTwice(record)) {
          await transport.send(record);
          const payload = record.payload as { operationId: string };
          await insertDefectMarks(tx, payload.operationId, [duplicateDeliveryMark(record)], options.clock?.now() ?? new Date());
        }
        await markOutboxPublished(tx, record.id);
        outcome.published += 1;
        sent = true;
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
        outcome.failed = true;
        break;
      }
      if (sent && options.onStatusChanged && isStatusChangedRecord(record)) {
        const observation = await observeStatusChange(tx, record);
        if (observation) observations.push(observation);
      }
    }
    return outcome;
  });
  for (const observation of observations) options.onStatusChanged?.(observation);
  return result;
}

export interface BackgroundLoop {
  stop(): Promise<void>;
}

export interface PublisherOptions extends PublishOptions {
  intervalMs?: number;
}

export function startOutboxPublisher(pool: Pool, transport: EventTransport, options: PublisherOptions = {}): BackgroundLoop {
  const intervalMs = options.intervalMs ?? 250;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  const tick = async (): Promise<void> => {
    let failures = 0;
    while (!stopped) {
      let idleMs = 0;
      try {
        const result = await publishPending(pool, transport, options);
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
