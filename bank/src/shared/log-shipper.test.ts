import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { bulkFailures, bulkPayload, LogShipper, skipWhileRunning } from './log-shipper';
import type { LogEntry } from './logger';

interface Call {
  url: string;
  method: string;
  body: string;
}

function entry(message: string, fields: Record<string, unknown> = {}): LogEntry {
  return { ts: '2026-10-23T09:15:00.000Z', level: 'info', service: 'bank-core', message, fields };
}

function scriptedFetch(replies: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? '') });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)] as () => Response | Promise<Response>;
    return reply();
  }) as typeof fetch;
  return { impl, calls };
}

const ok = (body: unknown = { errors: false, items: [] }) => () => new Response(JSON.stringify(body), { status: 200 });

describe('отправка журнала банка в Elasticsearch', () => {
  let clockMs: number;
  let stdout: string[];

  beforeEach(() => {
    clockMs = 1_000_000;
    stdout = [];
    const write = process.stdout.write.bind(process.stdout) as (chunk: string | Uint8Array) => boolean;
    mock.method(process.stdout, 'write', (chunk: string | Uint8Array) => {
      if (!String(chunk).startsWith('{')) return write(chunk);
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    mock.restoreAll();
  });

  const shipper = (replies: Array<() => Response | Promise<Response>>) => {
    const fetcher = scriptedFetch(replies);
    return { fetcher, shipper: new LogShipper({ url: 'http://elasticsearch:9200/', fetchImpl: fetcher.impl, now: () => clockMs }) };
  };

  it('запись ставится в очередь без сети, а flush отправляет пачку одним _bulk в индекс по дню', async () => {
    const { fetcher, shipper: s } = shipper([ok(), ok()]);
    s.push(entry('operation status changed', { operationNumber: 'ZB0000100001', status: 'COMPLETED' }));
    s.push(entry('sbp dispatch', { operationId: 'op-1' }));
    assert.equal(fetcher.calls.length, 0);
    assert.equal(s.pending(), 2);
    await s.flush();
    assert.equal(s.pending(), 0);
    const [template, bulk] = fetcher.calls;
    assert.equal(template?.url, 'http://elasticsearch:9200/_index_template/bank-logs');
    assert.equal(template?.method, 'PUT');
    assert.equal(bulk?.url, 'http://elasticsearch:9200/_bulk');
    const lines = (bulk?.body ?? '').trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 4);
    assert.deepEqual(lines[0], { index: { _index: 'bank-logs-2026.10.23' } });
    assert.equal(lines[1]?.operationNumber, 'ZB0000100001');
    assert.equal(lines[1]?.status, 'COMPLETED');
  });

  it('шаблон индекса отправляется один раз', async () => {
    const { fetcher, shipper: s } = shipper([ok()]);
    s.push(entry('one'));
    await s.flush();
    s.push(entry('two'));
    await s.flush();
    assert.deepEqual(fetcher.calls.map((call) => call.method), ['PUT', 'POST', 'POST']);
  });

  it('Elasticsearch недоступен: ничего не падает, записи ждут, повтор не раньше срока и без потерь', async () => {
    const { fetcher, shipper: s } = shipper([
      () => {
        throw new TypeError('fetch failed');
      },
      ok(),
    ]);
    s.push(entry('first'));
    await s.flush();
    assert.equal(s.pending(), 1);
    assert.equal(fetcher.calls.length, 1);
    await s.flush();
    assert.equal(fetcher.calls.length, 1);
    clockMs += 60_000;
    await s.flush();
    assert.equal(s.pending(), 0);
    assert.equal(fetcher.calls.filter((call) => call.url.endsWith('/_bulk')).length, 1);
  });

  it('ответ не 2xx оставляет пачку в очереди и сообщает причину в stdout, не в Elasticsearch', async () => {
    const { shipper: s } = shipper([ok(), () => new Response('boom', { status: 503 })]);
    s.push(entry('first'));
    await s.flush();
    assert.equal(s.pending(), 1);
    assert.ok(stdout.some((line) => line.includes('HTTP 503') && line.includes('"level":"warn"')));
    assert.equal(s.pending(), 1);
  });

  it('частичный отказ _bulk (errors: true) не молчит: причина попадает в предупреждение, пачка уходит', async () => {
    const { shipper: s } = shipper([
      ok({ errors: true, items: [{ index: { status: 400, error: { type: 'mapper_parsing_exception', reason: 'failed to parse field [status]' } } }, { index: { status: 201 } }] }),
    ]);
    s.push(entry('first'));
    s.push(entry('second'));
    await s.flush();
    assert.equal(s.pending(), 0);
    assert.ok(stdout.some((line) => line.includes('отклонил 1 из 2') && line.includes('mapper_parsing_exception')));
  });

  it('очередь ограничена: при переполнении старые записи отбрасываются', () => {
    const { shipper: s } = shipper([ok()]);
    for (let index = 0; index < 5100; index += 1) s.push(entry(`message ${index}`));
    assert.equal(s.pending(), 5000);
  });

  it('предупреждения о недоступности не чаще раза в пять минут', async () => {
    const { shipper: s } = shipper([
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    s.push(entry('first'));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      clockMs += 60_000;
      await s.flush();
    }
    assert.equal(stdout.filter((line) => line.includes('не уходит в Elasticsearch')).length, 1);
  });

  it('очередь переполнилась во время отправки: удаляются отправленные записи, а не первые по счёту', async () => {
    let bulkCalls = 0;
    let target: LogShipper | null = null;
    const impl = (async (url: string | URL | Request) => {
      if (String(url).endsWith('/_bulk')) {
        bulkCalls += 1;
        if (bulkCalls === 1) for (let index = 0; index < 5000; index += 1) target?.push(entry('новая', { index }));
      }
      return new Response(JSON.stringify({ errors: false, items: [] }), { status: 200 });
    }) as typeof fetch;
    const s = new LogShipper({ url: 'http://elasticsearch:9200', fetchImpl: impl, now: () => clockMs });
    target = s;
    for (let index = 0; index < 3; index += 1) s.push(entry('старая', { index }));
    await s.flush();
    assert.equal(bulkCalls, 5);
    assert.equal(s.pending(), 5000 - 4 * 500);
  });

  it('обновление метки не накладывается: пока прошлый запрос идёт, новый не начинается', async () => {
    let started = 0;
    let release: () => void = () => undefined;
    const tick = skipWhileRunning(
      () =>
        new Promise<void>((resolve) => {
          started += 1;
          release = resolve;
        }),
    );
    tick();
    tick();
    tick();
    assert.equal(started, 1);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    tick();
    assert.equal(started, 2);
  });

  it('разбор ответа _bulk и сборка тела', () => {
    assert.deepEqual(bulkFailures({ errors: false, items: [{ index: { status: 201 } }] }), { failed: 0, reason: '' });
    assert.equal(bulkFailures({ items: [{ index: { error: { type: 't', reason: 'r' } } }] }).failed, 1);
    assert.equal(bulkPayload([{ index: 'bank-logs-x', body: '{"a":1}' }]), '{"index":{"_index":"bank-logs-x"}}\n{"a":1}\n');
  });
});
