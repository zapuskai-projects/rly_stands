import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import { logger } from '../shared/logger';
import { parseSearchPath } from './schemas';

const MIGRATION_LOCK_ID = 87_000_001;

export async function runMigrations(pool: Pool, directory: string): Promise<string[]> {
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    const { business, internal } = parseSearchPath((await client.query<{ search_path: string }>('SHOW search_path')).rows[0]?.search_path ?? '');
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${internal}"`);
    await client.query("SELECT set_config('bank.internal_schema', $1, false)", [internal]);
    const legacy = await client.query('SELECT to_regclass($1) AS found', [`"${business}".schema_migrations`]);
    if (legacy.rows[0]?.found) await client.query(`ALTER TABLE "${business}".schema_migrations SET SCHEMA "${internal}"`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS "${internal}".schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = await client.query<{ version: string }>(`SELECT version FROM "${internal}".schema_migrations`);
    const applied = new Set(done.rows.map((row) => row.version));
    const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(directory, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(`INSERT INTO "${internal}".schema_migrations (version) VALUES ($1)`, [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Миграция ${file} не применилась: ${error instanceof Error ? error.message : String(error)}`);
      }
      appliedNow.push(file);
      logger.info('migration applied', { file });
    }
    return appliedNow;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}
