import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startHarness, type Harness } from '../testing/harness';
import { NOON_MOSCOW } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;

const BUSINESS_TABLES = ['accounts', 'cards', 'client_limits', 'clients', 'holds', 'notifications', 'operation_status_history', 'operations', 'partner_banks', 'postings', 'request_log', 'tariffs'];
const INTERNAL_TABLES = [
  'antifraud_decisions',
  'antifraud_settings',
  'defect_marks',
  'idempotency_keys',
  'login_challenges',
  'manual_reviews',
  'operator_sessions',
  'operators',
  'outbox_events',
  'sbp_directory',
  'sbp_transfers',
  'scenario',
  'schema_migrations',
  'sessions',
];

describe('таблицы банка по схемам', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
  });

  afterEach(async () => {
    await h.close();
  });

  async function tablesIn(position: 'business' | 'internal'): Promise<string[]> {
    const path = (await h.pool.query<{ search_path: string }>('SHOW search_path')).rows[0]?.search_path as string;
    const schema = (path.split(',')[position === 'business' ? 0 : 1] as string).trim();
    const result = await h.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name",
      [schema],
    );
    return result.rows.map((row) => row.table_name);
  }

  it('в бизнес-схеме только бизнес-таблицы, всё служебное, включая журнал миграций, во второй схеме', async () => {
    assert.deepEqual(await tablesIn('business'), BUSINESS_TABLES);
    assert.deepEqual(await tablesIn('internal'), INTERNAL_TABLES);
  });

  it('запросы без имени схемы по-прежнему находят и бизнес-, и служебные таблицы', async () => {
    assert.equal((await h.pool.query('SELECT 1 FROM clients')).rowCount, 6);
    assert.equal((await h.pool.query('SELECT 1 FROM scenario')).rowCount, 1);
    assert.equal((await h.pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', ['0008_internal_schema.sql'])).rowCount, 1);
  });
});
