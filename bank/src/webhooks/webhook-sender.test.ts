import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createHttpWebhookSender as createSender, type SenderOptions } from './webhook-sender';

const open: SenderOptions = { guard: () => null };
const createHttpWebhookSender = (timeoutMs: number, options: SenderOptions = open) => createSender(timeoutMs, options);

let server: Server;
let base: string;
let last: { headers: IncomingMessage['headers']; body: string; method: string } | null = null;

before(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      last = { headers: request.headers, body, method: request.method ?? '' };
      if (request.url === '/slow') return void setTimeout(() => response.writeHead(200).end(), 1500);
      if (request.url === '/redirect') return void response.writeHead(302, { Location: '/ok' }).end();
      if (request.url === '/fail') return void response.writeHead(500).end('boom');
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe('отправка уведомления по HTTP', () => {
  const request = (path: string) => ({ url: `${base}${path}`, headers: { 'Content-Type': 'application/json', 'X-Event-Id': 'e-1' }, body: '{"a":1}' });

  it('шлёт POST с телом и заголовками и отдаёт код ответа', async () => {
    const answer = await createHttpWebhookSender(1000)(request('/ok'));
    assert.deepEqual(answer, { kind: 'RESPONSE', status: 204 });
    assert.equal(last?.method, 'POST');
    assert.equal(last?.body, '{"a":1}');
    assert.equal(last?.headers['x-event-id'], 'e-1');
  });

  it('код ошибки возвращается как есть, перенаправление не выполняется', async () => {
    assert.deepEqual(await createHttpWebhookSender(1000)(request('/fail')), { kind: 'RESPONSE', status: 500 });
    assert.deepEqual(await createHttpWebhookSender(1000)(request('/redirect')), { kind: 'RESPONSE', status: 302 });
  });

  it('молчание дольше срока — TIMEOUT', async () => {
    assert.deepEqual(await createHttpWebhookSender(200)(request('/slow')), { kind: 'ERROR', error: 'TIMEOUT' });
  });

  it('закрытый порт — ECONNREFUSED', async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    assert.deepEqual(await createHttpWebhookSender(1000)({ ...request('/'), url: `http://127.0.0.1:${port}/` }), { kind: 'ERROR', error: 'ECONNREFUSED' });
  });

  it('адрес из разбора имени проверяется до соединения: loopback, неопределённый и link-local не получают запрос', async () => {
    last = null;
    const resolved = (address: string, family = 4) => ({ resolve: async () => [{ address, family }] });
    const cases: [string, string][] = [
      ['127.0.0.1', 'WEBHOOK_URL_LOOPBACK'],
      ['127.9.9.9', 'WEBHOOK_URL_LOOPBACK'],
      ['0.0.0.0', 'WEBHOOK_URL_LOOPBACK'],
      ['::1', 'WEBHOOK_URL_LOOPBACK'],
      ['::ffff:7f00:1', 'WEBHOOK_URL_LOOPBACK'],
      ['::', 'WEBHOOK_URL_LOOPBACK'],
      ['169.254.169.254', 'WEBHOOK_URL_FORBIDDEN'],
      ['fe80::1', 'WEBHOOK_URL_FORBIDDEN'],
    ];
    for (const [address, error] of cases) {
      const answer = await createSender(1000, resolved(address, address.includes(':') ? 6 : 4))({ ...request('/ok'), url: 'http://shop.example.test/ok' });
      assert.deepEqual(answer, { kind: 'ERROR', error }, address);
    }
    assert.equal(last, null);
  });

  it('если хоть один адрес имени запрещён, запрос не уходит и на остальные', async () => {
    last = null;
    const answer = await createSender(1000, { resolve: async () => [{ address: '10.0.0.5', family: 4 }, { address: '127.0.0.1', family: 4 }] })({ ...request('/ok'), url: 'http://shop.example.test/ok' });
    assert.deepEqual(answer, { kind: 'ERROR', error: 'WEBHOOK_URL_LOOPBACK' });
    assert.equal(last, null);
  });

  it('IP-адрес в ссылке проверяется без разбора имени, а запрещённый не доходит до сети', async () => {
    let resolverCalls = 0;
    const options = { resolve: async () => { resolverCalls += 1; return []; } };
    assert.deepEqual(await createSender(1000, options)({ ...request('/ok'), url: 'http://[::ffff:7f00:1]:1/ok' }), { kind: 'ERROR', error: 'WEBHOOK_URL_LOOPBACK' });
    assert.deepEqual(await createSender(1000, options)({ ...request('/ok'), url: 'http://169.254.169.254/latest' }), { kind: 'ERROR', error: 'WEBHOOK_URL_FORBIDDEN' });
    assert.equal(resolverCalls, 0);
  });

  it('имя разбирается один раз, соединение идёт на проверенный адрес, заголовок Host остаётся с именем (подмена DNS между проверкой и соединением невозможна)', async () => {
    let calls = 0;
    const port = new URL(base).port;
    const answer = await createSender(1000, {
      guard: () => null,
      resolve: async () => {
        calls += 1;
        return [{ address: calls === 1 ? '127.0.0.1' : '203.0.113.9', family: 4 }];
      },
    })({ ...request('/ok'), url: `http://shop.example.test:${port}/ok` });
    assert.deepEqual(answer, { kind: 'RESPONSE', status: 204 });
    assert.equal(calls, 1);
    assert.equal(last?.headers.host, `shop.example.test:${port}`);
  });

  it('частный адрес разрешён: имя вроде host.docker.internal не отвергается, ошибка соединения приходит как код сети', async () => {
    const answer = await createSender(1000, { resolve: async () => [{ address: '10.255.255.1', family: 4 }] })({ ...request('/ok'), url: 'http://host.docker.internal:9/ok' });
    assert.equal(answer.kind, 'ERROR');
    assert.ok(answer.kind === 'ERROR' && answer.error !== 'WEBHOOK_URL_LOOPBACK' && answer.error !== 'WEBHOOK_URL_FORBIDDEN');
  });

  it('имя, которое не разбирается, — ENOTFOUND', async () => {
    const answer = await createSender(1000, { resolve: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } })({ ...request('/ok'), url: 'http://unreachable.invalid/ok' });
    assert.deepEqual(answer, { kind: 'ERROR', error: 'ENOTFOUND' });
    assert.deepEqual(await createSender(1000, { resolve: async () => [] })({ ...request('/ok'), url: 'http://empty.invalid/ok' }), { kind: 'ERROR', error: 'ENOTFOUND' });
  });
});
