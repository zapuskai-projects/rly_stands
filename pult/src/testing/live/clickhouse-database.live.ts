import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { READINESS } from '../../modules/readiness';
import { liveSuite } from './support';

type Facts = Record<string, any>;

liveSuite('data', READINESS.clickhouse ?? [], 'ClickHouse: выбор базы готового решения', ({ probe, write }) => {
  const cleanup = 'DROP TABLE IF EXISTS default.live_antifraud_decisions; DROP TABLE IF EXISTS student.live_antifraud_decisions; DROP TABLE IF EXISTS default.live_database_priority; DROP TABLE IF EXISTS student.live_database_priority';
  before(async () => {
    const rows = Array.from({ length: 14 }, (_, index) => {
      const decision = [0, 7, 8].includes(index) ? 'REVIEW' : [1, 9].includes(index) ? 'REJECT' : 'APPROVE';
      return `('op${index}', '${decision}', '2026-01-01 ${index < 7 ? '00' : '01'}:30:00')`;
    }).join(',');
    await probe('clickhouse.sql', { sql: `${cleanup};
      CREATE TABLE default.live_antifraud_decisions (operationNumber String, decision String, decidedAt DateTime64(3, 'Europe/Moscow')) ENGINE = MergeTree ORDER BY (decidedAt, operationNumber);
      INSERT INTO default.live_antifraud_decisions VALUES ${rows};
      CREATE TABLE default.live_database_priority (id UInt32) ENGINE = MergeTree ORDER BY id;
      INSERT INTO default.live_database_priority VALUES (1);
      CREATE TABLE student.live_database_priority (id UInt32) ENGINE = MergeTree ORDER BY id;
      INSERT INTO student.live_database_priority VALUES (1), (2)` });
  });
  after(async () => { await probe('clickhouse.sql', { sql: cleanup }); });

  it('находит витрину в default и выполняет сохранённый отчёт без переноса данных', async () => {
    const table = await probe<Facts>('clickhouse.table', { name: 'live_antifraud_decisions' });
    assert.equal(table.database, 'default');
    assert.equal(table.exists, true);
    assert.equal(table.engine, 'MergeTree');
    assert.equal(table.rows, 14);
    const totals = await probe<Facts>('clickhouse.query', {
      sql: 'SELECT uniqExact(operationNumber) AS operations, count() AS decisions FROM live_antifraud_decisions',
    });
    assert.equal(totals.database, 'default');
    assert.deepEqual(totals.rows, [{ operations: 14, decisions: 14 }]);
    write('antifraud-report.sql', "SELECT toStartOfHour(toTimeZone(decidedAt, 'Europe/Moscow')) AS hour, count() AS total, round(countIf(decision = 'REVIEW') / count(), 2) AS review_share, round(countIf(decision = 'REJECT') / count(), 2) AS reject_share FROM live_antifraud_decisions GROUP BY hour ORDER BY hour");
    const report = await probe<Facts>('clickhouse.queryFile', { file: 'antifraud-report.sql' });
    assert.equal(report.database, 'default');
    assert.equal(report.queryError, null);
    assert.equal(report.file.exists, true);
    assert.deepEqual(report.columns, ['hour', 'total', 'review_share', 'reject_share']);
    assert.deepEqual(report.rows.map((row: Facts) => [row.total, row.review_share, row.reject_share]), [[7, 0.14, 0.14], [7, 0.29, 0.14]]);
    const explicit = await probe<Facts>('clickhouse.table', { db: 'student', name: 'live_antifraud_decisions' });
    assert.equal(explicit.exists, false);
  });

  it('сохраняет приоритет student и явный выбор базы', async () => {
    const table = await probe<Facts>('clickhouse.table', { name: 'live_database_priority' });
    assert.equal(table.database, 'student');
    assert.equal(table.rows, 2);
    const explicit = await probe<Facts>('clickhouse.table', { db: 'default', name: 'live_database_priority' });
    assert.equal(explicit.database, 'default');
    assert.equal(explicit.rows, 1);
    const result = await probe<Facts>('clickhouse.query', { sql: 'SELECT count() AS total FROM live_database_priority' });
    assert.equal(result.database, 'student');
    assert.deepEqual(result.rows, [{ total: 2 }]);
  });

  it('не меняет данные при проверке и сохраняет ошибку отсутствующего объекта', async () => {
    const missing = await probe<Facts>('clickhouse.query', { sql: 'SELECT * FROM live_database_absent' });
    assert.match(missing.queryError, /live_database_absent/);
    assert.deepEqual(missing.searchedDatabases, ['student', 'default']);
    const denied = await probe<Facts>('clickhouse.query', { sql: 'INSERT INTO default.live_database_priority VALUES (3)' });
    assert.match(denied.queryError, /readonly/i);
    const table = await probe<Facts>('clickhouse.table', { db: 'default', name: 'live_database_priority' });
    assert.equal(table.rows, 1);
  });
});
