import type { Pool } from 'pg';
import { ensureDatabase } from '../db/ensure-database';
import type { Config } from '../config';
import { MIGRATIONS_DIR } from '../config';
import { runMigrations } from '../db/migrate';
import { createPool } from '../db/pool';
import { logger } from '../shared/logger';

const DATABASE_ATTEMPTS = 15;
const DATABASE_RETRY_MS = 2000;

async function waitForDatabase(pool: Pool, databaseUrl: string): Promise<void> {
  for (let attempt = 1; attempt <= DATABASE_ATTEMPTS; attempt += 1) {
    try {
      if (await ensureDatabase(databaseUrl)) logger.info('database created');
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('database is not ready', { attempt, error: reason });
      if (attempt === DATABASE_ATTEMPTS) throw new Error(`База данных банка недоступна (${reason}): проверьте BANK_DATABASE_URL и запуск PostgreSQL`);
      await new Promise((resolve) => setTimeout(resolve, DATABASE_RETRY_MS));
    }
  }
}

export async function connectDatabase(config: Config): Promise<Pool> {
  const pool = createPool(config.databaseUrl);
  await waitForDatabase(pool, config.databaseUrl);
  await runMigrations(pool, MIGRATIONS_DIR);
  return pool;
}

export function onShutdown(task: () => Promise<void>): void {
  let started = false;
  const handler = () => {
    if (started) return;
    started = true;
    task()
      .catch((error: unknown) => logger.error('shutdown failed', { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => process.exit(0));
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
