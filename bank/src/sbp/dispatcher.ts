import { BANK } from '../shared/bank-identity';
import { logger } from '../shared/logger';
import { toApiAmount } from '../accounts/money';
import type { BackgroundLoop } from '../events/outbox.publisher';
import type { SbpGateway } from './gateway';
import { applySbpOutcome, type SbpDeps } from './outcome';

const CLAIM_BATCH = 10;
const RECOVERY_GRACE_MS = 5000;

async function claim(deps: SbpDeps, limit: number): Promise<string[]> {
  const result = await deps.pool.query<{ operation_id: string }>(
    `UPDATE sbp_transfers SET state = 'SENT', dispatched_at = now()
     WHERE operation_id IN (
       SELECT operation_id FROM sbp_transfers WHERE state = 'PENDING' ORDER BY created_at, operation_id LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING operation_id`,
    [limit],
  );
  return result.rows.map((row) => row.operation_id);
}

async function dispatchOne(deps: SbpDeps, gateway: SbpGateway, operationId: string): Promise<void> {
  const result = await deps.pool.query<{
    number: string;
    amount_kop: bigint;
    recipient_phone: string;
    recipient_bank_code: string;
    request_id: string | null;
  }>('SELECT number, amount_kop, recipient_phone, recipient_bank_code, request_id FROM operations WHERE id = $1', [operationId]);
  const operation = result.rows[0];
  if (!operation) return;
  const requestId = operation.request_id ?? 'unknown';
  logger.info('sbp dispatch', { operationId, requestId });
  const answer = await gateway.send({
    operationId,
    operationNumber: operation.number,
    amount: toApiAmount(operation.amount_kop),
    currency: 'RUB',
    recipientPhone: operation.recipient_phone,
    recipientBankCode: operation.recipient_bank_code,
    senderBank: BANK.code,
    requestId,
  });
  const applied = await applySbpOutcome(deps, operationId, answer, requestId);
  logger.info('sbp answer', { operationId, requestId, answer: answer.kind, applied });
}

export async function dispatchPendingSbp(deps: SbpDeps, gateway: SbpGateway): Promise<number> {
  const claimed = await claim(deps, CLAIM_BATCH);
  await Promise.all(claimed.map((operationId) => dispatchOne(deps, gateway, operationId)));
  return claimed.length;
}

export async function recoverStuckSbp(deps: SbpDeps, timeoutMs: number): Promise<number> {
  const stuck = await deps.pool.query<{ operation_id: string; request_id: string | null }>(
    `SELECT t.operation_id, o.request_id FROM sbp_transfers t JOIN operations o ON o.id = t.operation_id
     WHERE t.state = 'SENT' AND t.dispatched_at < now() - ($1::int * interval '1 millisecond')`,
    [timeoutMs + RECOVERY_GRACE_MS],
  );
  let recovered = 0;
  for (const row of stuck.rows) {
    if (await applySbpOutcome(deps, row.operation_id, { kind: 'TIMEOUT' }, row.request_id ?? 'unknown')) recovered += 1;
  }
  return recovered;
}

export function startSbpDispatcher(deps: SbpDeps, gateway: SbpGateway, timeoutMs: number, intervalMs = 300): BackgroundLoop {
  let stopped = false;
  const inFlight = new Set<Promise<void>>();
  let lastRecovery = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        if (inFlight.size < CLAIM_BATCH) {
          for (const operationId of await claim(deps, CLAIM_BATCH - inFlight.size)) {
            const task: Promise<void> = dispatchOne(deps, gateway, operationId)
              .catch((error: unknown) => logger.error('sbp dispatch failed', { operationId, error: error instanceof Error ? error.message : String(error) }))
              .finally(() => inFlight.delete(task));
            inFlight.add(task);
          }
        }
        if (Date.now() - lastRecovery > RECOVERY_GRACE_MS) {
          lastRecovery = Date.now();
          await recoverStuckSbp(deps, timeoutMs);
        }
      } catch (error) {
        logger.warn('sbp dispatcher cycle failed', { error: error instanceof Error ? error.message : String(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      await Promise.allSettled([...inFlight]);
    },
  };
}
