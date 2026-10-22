import { Pool, types, type QueryResult, type QueryResultRow } from 'pg';
import { logger } from '../shared/logger';
import { searchPathOptions } from './schemas';

types.setTypeParser(20, (value: string) => BigInt(value));

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export function createPool(connectionString: string): Pool {
  const pool = new Pool({ connectionString, max: 10, options: searchPathOptions() });
  pool.on('error', (error) => {
    logger.error('idle database client failed', { error: error.message });
  });
  return pool;
}

export async function withTransaction<T>(pool: Pool, work: (tx: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
