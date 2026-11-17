import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLICKHOUSE_EXECUTORS, queryErrorOf } from './clickhouse';

describe('queryErrorOf', () => {
  it('текст ошибки сервера без обвязки', () => {
    assert.equal(
      queryErrorOf("Code: 60. DB::Exception: Table student.live_missing does not exist. (UNKNOWN_TABLE) (version 24.8.14.39 (official build))\n"),
      'Table student.live_missing does not exist. (UNKNOWN_TABLE) (version 24.8.14.39 (official build))',
    );
  });

  it('ошибка внутри JSON-ответа не превращается в «{»', () => {
    const body = '{\n\t"meta":\n\t[\n\n\t],\n\t"rows": 0,\n\t"exception": "Code: 164. DB::Exception: student: Cannot execute query in readonly mode. (READONLY) (version 24.8)"\n}';
    assert.match(queryErrorOf(body) ?? '', /^student: Cannot execute query in readonly mode/);
  });

  it('текст без кода сервера — первая непустая строка, пустой ответ — null', () => {
    assert.equal(queryErrorOf('\n  плохой запрос\nвторая строка'), 'плохой запрос');
    assert.equal(queryErrorOf('  \n'), null);
  });
});

it('сохраняет метаданные именно выполненного SQL, включая ошибку ClickHouse', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'clickhouse-report-'));
  const ctx = { workDir, label: '' };
  const executor = CLICKHOUSE_EXECUTORS['clickhouse.queryFile']!;
  let calls = 0;
  try {
    mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
      calls += 1;
      assert.equal(init.body, 'SELECT * FROM missing');
      return new Response('Code: 60. DB::Exception: Unknown table student.missing', { status: 404 });
    });
    const absent = await executor({ file: 'report.sql' }, ctx) as { file: { exists: boolean }; queryError: string };
    assert.equal(absent.file.exists, false);
    assert.match(absent.queryError, /файла work\/report.sql нет/);
    writeFileSync(join(workDir, 'report.sql'), '');
    const empty = await executor({ file: 'report.sql' }, ctx) as { file: { exists: boolean }; queryError: string };
    assert.equal(empty.file.exists, true);
    assert.match(empty.queryError, /пуст/);
    writeFileSync(join(workDir, 'report.sql'), '{\\rtf1 formatted SQL}');
    assert.match((await executor({ file: 'report.sql' }, ctx) as { queryError: string }).queryError, /RTF/);
    assert.equal(calls, 0);
    writeFileSync(join(workDir, 'report.sql'), 'SELECT * FROM missing;');
    const failed = await executor({ file: 'report.sql' }, ctx) as { file: { exists: boolean; size: number; sha256: string }; queryError: string };
    assert.equal(failed.file.exists, true);
    assert.equal(failed.file.size, Buffer.byteLength('SELECT * FROM missing;'));
    assert.match(failed.file.sha256, /^[a-f0-9]{64}$/);
    assert.match(failed.queryError, /Unknown table student.missing/);
    assert.equal(calls, 1);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [], exception: 'Code: 60. DB::Exception: Late query error' }), { status: 200 }));
    assert.match((await executor({ file: 'report.sql' }, ctx) as { queryError: string }).queryError, /Late query error/);
    mock.restoreAll();
    mock.method(globalThis, 'fetch', async () => new Response('Access denied', { status: 401 }));
    await assert.rejects(executor({ file: 'report.sql' }, ctx), /ClickHouse/);
  } finally { mock.restoreAll(); rmSync(workDir, { recursive: true, force: true }); }
});
