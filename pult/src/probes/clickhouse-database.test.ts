import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
import { CLICKHOUSE_EXECUTORS } from './clickhouse';

const context = { workDir: '', label: '' };
const query = (sql: string) => CLICKHOUSE_EXECUTORS['clickhouse.query']!({ sql }, context) as Promise<Record<string, unknown>>;
const missing = (database: string) => new Response(`Code: 60. DB::Exception: Unknown table ${database}.events (UNKNOWN_TABLE)`, { status: 404 });
const success = () => new Response(JSON.stringify({ data: [{ total: 14 }], meta: [{ name: 'total' }] }));

it('успешный запрос student не обращается к другой базе', async (t) => {
  t.after(() => mock.restoreAll());
  const databases: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string) => {
    databases.push(new URL(url).searchParams.get('database')!);
    return success();
  });
  assert.deepEqual((await query('SELECT count() AS total FROM events')).rows, [{ total: 14 }]);
  assert.deepEqual(databases, ['student']);
});

it('таблица из default доступна после UNKNOWN_TABLE, обе проверки только читают', async (t) => {
  t.after(() => mock.restoreAll());
  const databases: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const params = new URL(url).searchParams;
    const database = params.get('database')!;
    assert.equal(params.get('readonly'), '1');
    assert.equal(init.body, 'SELECT count() AS total FROM events');
    databases.push(database);
    return database === 'student' ? missing(database) : success();
  });
  const result = await query('SELECT count() AS total FROM events;');
  assert.equal(result.database, 'default');
  assert.equal(result.queryError, null);
  assert.deepEqual(result.rows, [{ total: 14 }]);
  assert.deepEqual(databases, ['student', 'default']);
});

it('при отсутствии таблицы в обеих базах сохраняет исходную ошибку и список баз', async (t) => {
  t.after(() => mock.restoreAll());
  mock.method(globalThis, 'fetch', async (url: string) => missing(new URL(url).searchParams.get('database')!));
  const result = await query('SELECT * FROM events');
  assert.match(String(result.queryError), /student\.events/);
  assert.deepEqual(result.searchedDatabases, ['student', 'default']);
});

it('ошибка синтаксиса не переключает базу', async (t) => {
  t.after(() => mock.restoreAll());
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return new Response('Code: 62. DB::Exception: Syntax error (SYNTAX_ERROR)', { status: 400 });
  });
  assert.match(String((await query('SELECT broken')).queryError), /Syntax error/);
  assert.equal(calls, 1);
});

it('ошибка доступа не повторяет запрос с другой базой', async (t) => {
  t.after(() => mock.restoreAll());
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response('Access denied', { status: 401 }); });
  await assert.rejects(query('SELECT * FROM events'), /ClickHouse/);
  assert.equal(calls, 1);
});
