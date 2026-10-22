import assert from 'node:assert/strict';
import { before, it } from 'node:test';
import { READINESS } from '../../modules/readiness';
import { liveSuite } from './support';

type Facts = Record<string, any>;

liveSuite('data', READINESS.postgres ?? [], 'PostgreSQL: проверки на живой базе', ({ probe }) => {
  it('таблицы создаются студенческими командами, структура читается полностью', async () => {
    await probe('postgres.sql', {
      sql: `
        DROP TABLE IF EXISTS live_orders;
        DROP TABLE IF EXISTS live_customers;
        CREATE TABLE live_customers (id serial PRIMARY KEY, name text NOT NULL);
        CREATE TABLE live_orders (
          id serial PRIMARY KEY,
          customer_id int NOT NULL REFERENCES live_customers(id),
          amount numeric(12,2) NOT NULL DEFAULT 0,
          note text
        );
        CREATE UNIQUE INDEX live_orders_customer_amount ON live_orders (customer_id, amount);
        CREATE INDEX live_orders_note ON live_orders (note);
      `,
    });
    const table = await probe<Facts>('postgres.table', { name: 'live_orders' });
    assert.equal(table.exists, true);
    assert.deepEqual(table.columns.map((column: Facts) => column.name), ['id', 'customer_id', 'amount', 'note']);
    const amount = table.columns.find((column: Facts) => column.name === 'amount');
    assert.equal(amount.type, 'numeric(12,2)');
    assert.equal(amount.nullable, false);
    assert.match(amount.default, /0/);
    assert.equal(table.columns.find((column: Facts) => column.name === 'note').nullable, true);
    assert.deepEqual(table.primaryKey, ['id']);
    assert.deepEqual(table.foreignKeys, [{ columns: ['customer_id'], refTable: 'live_customers', refColumns: ['id'] }]);
    const indexes = Object.fromEntries(table.indexes.map((index: Facts) => [index.name, index]));
    assert.deepEqual(indexes.live_orders_customer_amount.columns, ['customer_id', 'amount']);
    assert.equal(indexes.live_orders_customer_amount.unique, true);
    assert.equal(indexes.live_orders_note.unique, false);
    assert.deepEqual(table.uniqueKeys, [['customer_id', 'amount']]);
    assert.equal(table.rows, 0);
  });

  it('таблицы нет — exists=false, число строк считается по факту', async () => {
    assert.equal((await probe<Facts>('postgres.table', { name: 'live_absent' })).exists, false);
    await probe('postgres.sql', {
      sql: "INSERT INTO live_customers (name) VALUES ('Анна'), ('Пётр'); INSERT INTO live_orders (customer_id, amount) VALUES (1, 10), (2, 20);",
    });
    assert.equal((await probe<Facts>('postgres.table', { name: 'live_orders' })).rows, 2);
  });

  it('запрос на чтение отдаёт строки, ошибка студента — queryError, а не сбой', async () => {
    const ok = await probe<Facts>('postgres.query', {
      sql: 'SELECT c.name, o.amount::text AS amount FROM live_orders o JOIN live_customers c ON c.id = o.customer_id ORDER BY o.id',
    });
    assert.equal(ok.rowCount, 2);
    assert.deepEqual(ok.rows, [
      { name: 'Анна', amount: '10.00' },
      { name: 'Пётр', amount: '20.00' },
    ]);
    assert.equal(ok.queryError, null);
    const broken = await probe<Facts>('postgres.query', { sql: 'SELECT * FROM live_missing' });
    assert.equal(broken.rowCount, 0);
    assert.match(broken.queryError, /live_missing/);
  });

  it('транзакция проверки: ошибка SQL — факты с кодом, запись откатывается, управлять транзакцией нельзя', async () => {
    const orphan = await probe<Facts>('postgres.tx', { sql: 'INSERT INTO live_orders (customer_id, amount) VALUES (999, 1)' });
    assert.equal(orphan.failed, true);
    assert.equal(orphan.code, '23503');
    assert.match(orphan.constraint, /customer_id_fkey/);
    const missing = await probe<Facts>('postgres.tx', { sql: 'SELECT 1 FROM live_no_such_table' });
    assert.equal(missing.code, '42P01');

    const written = await probe<Facts>('postgres.tx', {
      sql: "INSERT INTO live_customers (name) VALUES ('Тест'); INSERT INTO live_orders (customer_id, amount) SELECT id, 5 FROM live_customers WHERE name = 'Тест'; SELECT count(*)::int AS orders FROM live_orders",
    });
    assert.equal(written.failed, false);
    assert.deepEqual(written.rows, [{ orders: 3 }]);
    assert.equal((await probe<Facts>('postgres.table', { name: 'live_orders' })).rows, 2);
    assert.equal((await probe<Facts>('postgres.table', { name: 'live_customers' })).rows, 2);

    await assert.rejects(probe('postgres.tx', { sql: "INSERT INTO live_customers (name) VALUES ('Утечка'); COMMIT" }), /нельзя управлять транзакцией/);
    assert.equal((await probe<Facts>('postgres.table', { name: 'live_customers' })).rows, 2);
  });

  it('запись через запрос на чтение не проходит и ничего не меняет', async () => {
    const attempt = await probe<Facts>('postgres.query', { sql: "INSERT INTO live_customers (name) VALUES ('Тайно')" });
    assert.match(attempt.queryError, /read-only/i);
    assert.equal((await probe<Facts>('postgres.table', { name: 'live_customers' })).rows, 2);
  });

  it('команда с ошибкой — отказ действия с текстом базы; долгий запрос обрывается по таймауту', async () => {
    await assert.rejects(probe('postgres.sql', { sql: 'CREATE TABLE live_customers (id int)' }), /already exists/);
    const slow = await probe<Facts>('postgres.query', { sql: 'SELECT pg_sleep(12)' });
    assert.match(slow.queryError, /timeout/i);
    assert.equal(slow.rowCount, 0);
  });

  it('уборка', async () => {
    await probe('postgres.sql', { sql: 'DROP TABLE live_orders; DROP TABLE live_customers;' });
    assert.equal((await probe<Facts>('postgres.table', { name: 'live_orders' })).exists, false);
  });
});

liveSuite('data', (READINESS.elasticsearch ?? []).slice(0, 1), 'Elasticsearch: проверки на живом поиске', ({ probe, write }) => {
  const mappings = { properties: { customer: { type: 'keyword' }, amount: { type: 'double' }, note: { type: 'text' } } };

  before(async () => {
    await fetch('http://elasticsearch:9200/live-orders', { method: 'DELETE' });
  });

  it('индекс создаётся один раз, шарды и поля читаются', async () => {
    assert.deepEqual(
      await probe('elasticsearch.createIndex', {
        name: 'live-orders',
        mappings,
        settings: { number_of_shards: 1, number_of_replicas: 0 },
      }),
      { created: true },
    );
    assert.deepEqual(await probe('elasticsearch.createIndex', { name: 'live-orders', mappings }), { created: false });
    const index = await probe<Facts>('elasticsearch.index', { name: 'live-orders' });
    assert.equal(index.exists, true);
    assert.equal(index.shards, 1);
    assert.equal(index.replicas, 0);
    assert.equal(index.docs, 0);
    const fields = Object.fromEntries(index.fields.map((field: Facts) => [field.name, field.type]));
    assert.deepEqual(fields, { customer: 'keyword', amount: 'double', note: 'text' });
  });

  it('индекса нет — exists=false', async () => {
    const index = await probe<Facts>('elasticsearch.index', { name: 'live-absent' });
    assert.equal(index.exists, false);
    assert.equal(index.docs, 0);
  });

  it('документы загружаются сразу видимыми, поиск идёт из тела и из файла', async () => {
    assert.deepEqual(
      await probe('elasticsearch.bulk', {
        index: 'live-orders',
        docs: [
          { _id: 1, customer: 'ivan', amount: 10, note: 'срочный заказ' },
          { _id: 2, customer: 'anna', amount: 25, note: 'обычный заказ' },
          { _id: 3, customer: 'anna', amount: 40, note: 'срочная доставка' },
        ],
      }),
      { indexed: 3 },
    );
    assert.equal((await probe<Facts>('elasticsearch.index', { name: 'live-orders' })).docs, 3);
    const byTerm = await probe<Facts>('elasticsearch.search', { index: 'live-orders', query: { query: { term: { customer: 'anna' } } } });
    assert.equal(byTerm.total, 2);
    assert.deepEqual([...byTerm.ids].sort(), ['2', '3']);
    assert.equal(byTerm.queryError, null);
    write('query.json', JSON.stringify({ query: { match: { note: 'срочный' } } }));
    const fromFile = await probe<Facts>('elasticsearch.search', { index: 'live-orders', queryFile: 'query.json' });
    assert.equal(fromFile.total, 1);
    assert.deepEqual(fromFile.ids, ['1']);
  });

  it('ошибки студента — queryError: нет файла, не JSON, неверный запрос, нет индекса', async () => {
    const missingFile = await probe<Facts>('elasticsearch.search', { index: 'live-orders', queryFile: 'absent.json' });
    assert.match(missingFile.queryError, /absent\.json/);
    write('broken.json', '{ query');
    const notJson = await probe<Facts>('elasticsearch.search', { index: 'live-orders', queryFile: 'broken.json' });
    assert.match(notJson.queryError, /не JSON/);
    const unknown = await probe<Facts>('elasticsearch.search', { index: 'live-orders', query: { query: { no_such_query: {} } } });
    assert.equal(unknown.total, 0);
    assert.match(unknown.queryError, /no_such_query/);
    const absent = await probe<Facts>('elasticsearch.search', { index: 'live-absent', query: {} });
    assert.match(absent.queryError, /live-absent/);
  });
});

liveSuite('data', READINESS.clickhouse ?? [], 'ClickHouse: проверки на живой базе', ({ probe, write }) => {
  it('несколько команд подряд, точка с запятой внутри строки не режет команду', async () => {
    await probe('clickhouse.sql', {
      sql: `
        DROP TABLE IF EXISTS live_events;
        CREATE TABLE live_events (ts DateTime, user_id UInt32, action String)
          ENGINE = MergeTree PARTITION BY toYYYYMM(ts) ORDER BY (user_id, ts) TTL ts + INTERVAL 30 DAY;
        INSERT INTO live_events VALUES ('2026-10-01 10:00:00', 1, 'a;b');
      `,
    });
    const table = await probe<Facts>('clickhouse.table', { name: 'live_events' });
    assert.equal(table.exists, true);
    assert.equal(table.engine, 'MergeTree');
    assert.equal(table.sortingKey, 'user_id, ts');
    assert.equal(table.partitionKey, 'toYYYYMM(ts)');
    assert.match(table.ttl, /30/);
    assert.deepEqual(table.columns.map((column: Facts) => `${column.name}:${column.type}`), ['ts:DateTime', 'user_id:UInt32', 'action:String']);
    assert.equal(table.rows, 1);
  });

  it('таблицы нет — exists=false; строки вставляются пакетом', async () => {
    assert.equal((await probe<Facts>('clickhouse.table', { name: 'live_absent' })).exists, false);
    assert.deepEqual(
      await probe('clickhouse.insert', {
        table: 'live_events',
        rows: [
          { ts: '2026-10-02 11:00:00', user_id: 2, action: 'view' },
          { ts: '2026-10-02 11:05:00', user_id: 2, action: 'click' },
        ],
      }),
      { inserted: 2 },
    );
    assert.equal((await probe<Facts>('clickhouse.table', { name: 'live_events' })).rows, 3);
  });

  it('запрос на чтение: строки, из файла, ошибка студента — queryError, запись запрещена', async () => {
    const rows = await probe<Facts>('clickhouse.query', {
      sql: 'SELECT user_id, count() AS events FROM live_events GROUP BY user_id ORDER BY user_id',
    });
    assert.equal(rows.rowCount, 2);
    assert.deepEqual(rows.rows.map((row: Facts) => [Number(row.user_id), Number(row.events)]), [[1, 1], [2, 2]]);
    write('events.sql', 'SELECT action FROM live_events WHERE user_id = 2 ORDER BY ts;');
    const fromFile = await probe<Facts>('clickhouse.queryFile', { file: 'events.sql' });
    assert.deepEqual(fromFile.rows, [{ action: 'view' }, { action: 'click' }]);
    assert.match((await probe<Facts>('clickhouse.queryFile', { file: 'absent.sql' })).queryError, /absent\.sql/);
    write('empty.sql', '  \n');
    assert.match((await probe<Facts>('clickhouse.queryFile', { file: 'empty.sql' })).queryError, /пуст/);
    const broken = await probe<Facts>('clickhouse.query', { sql: 'SELECT * FROM live_missing' });
    assert.equal(broken.rowCount, 0);
    assert.match(broken.queryError, /live_missing/);
    const write_attempt = await probe<Facts>('clickhouse.query', { sql: "INSERT INTO live_events VALUES ('2026-10-03 00:00:00', 3, 'x')" });
    assert.match(write_attempt.queryError, /readonly/i);
    assert.equal((await probe<Facts>('clickhouse.table', { name: 'live_events' })).rows, 3);
  });

  it('уборка', async () => {
    await probe('clickhouse.sql', { sql: 'DROP TABLE live_events' });
    assert.equal((await probe<Facts>('clickhouse.table', { name: 'live_events' })).exists, false);
  });
});
