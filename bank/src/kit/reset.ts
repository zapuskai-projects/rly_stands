import type { Pool } from 'pg';
import type { BankClock } from '../clock/bank-clock';
import { withTransaction } from '../db/pool';
import { shiftBankTime } from '../scenario/bank-time';
import { seedIfEmpty } from '../seed/seed';
import { logger } from '../shared/logger';
import { retryOnConflict } from '../shared/retry';
import { restoreDefaultTariffs } from './tariffs';

const CLIENT_DATA_TABLES = [
  'defect_marks',
  'operation_status_history',
  'postings',
  'holds',
  'idempotency_keys',
  'antifraud_decisions',
  'manual_reviews',
  'sbp_transfers',
  'notifications',
  'outbox_events',
  'request_log',
  'sessions',
  'login_challenges',
  'client_limits',
  'cards',
  'operations',
  'accounts',
  'clients',
  'operator_sessions',
  'operators',
];

const FIRST_OPERATION_NUMBER = 100_001;
const RESET_LOCK_ID = 87_000_003;

const LOCK_TIMEOUT = '3s';

async function resetOnce(deps: { pool: Pool; clock: BankClock }): Promise<void> {
  await withTransaction(deps.pool, async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await tx.query('SELECT pg_advisory_xact_lock($1)', [RESET_LOCK_ID]);
    await tx.query(`TRUNCATE ${CLIENT_DATA_TABLES.join(', ')} RESTART IDENTITY`);
    await tx.query(`ALTER SEQUENCE operation_number_seq RESTART WITH ${FIRST_OPERATION_NUMBER}`);
    await tx.query('DELETE FROM scenario');
    await tx.query('INSERT INTO scenario (id) VALUES (1)');
    await tx.query('DELETE FROM antifraud_settings');
    await tx.query('INSERT INTO antifraud_settings (id) VALUES (1)');
    await restoreDefaultTariffs(tx);
  });
  await shiftBankTime(deps.pool, deps.clock, null);
  await seedIfEmpty(deps.pool, deps.clock);
}

export async function resetBank(deps: { pool: Pool; clock: BankClock }): Promise<void> {
  await retryOnConflict(() => resetOnce(deps), {
    onRetry: (error, attempt) => {
      logger.warn('bank reset conflicted with background work, retrying', {
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
