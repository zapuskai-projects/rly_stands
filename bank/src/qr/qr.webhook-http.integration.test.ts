import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, type Harness } from '../testing/harness';
import { listDeliveries, payOrder, setWebhookDirect, startOnRelease } from '../testing/qr';
import { dispatchDueWebhooks } from '../webhooks/webhook-dispatcher';
import { createHttpWebhookSender } from '../webhooks/webhook-sender';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const SECRET = 'receiver-secret';

describe('настоящий приёмник: подпись сходится, ответы и тайм-аут попадают в журнал', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;
  let receiver: Server;
  let url: string;
  let received: { signature: string; eventId: string; body: string; valid: boolean }[] = [];
  let respond: (request: IncomingMessage) => { status: number; delayMs?: number } = () => ({ status: 200 });

  beforeEach(async () => {
    h = await startOnRelease('1.2');
    received = [];
    receiver = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const signature = String(request.headers['x-signature']);
        const expected = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
        received.push({ signature, eventId: String(request.headers['x-event-id']), body, valid: signature === expected });
        const answer = respond(request);
        setTimeout(() => response.writeHead(answer.status).end(), answer.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhook`;
  });

  afterEach(async () => {
    receiver.closeAllConnections();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    await h.close();
  });

  const dispatch = (realNow: Date, timeoutMs = 300) => dispatchDueWebhooks({ pool: h.pool, clock: h.clock, send: createHttpWebhookSender(timeoutMs, { guard: () => null }), realNow: () => realNow });

  it('приёмник получает qr.paid, проверяет подпись по своему секрету и отвечает 200', async () => {
    await setWebhookDirect(h, url, SECRET);
    const paid = await payOrder(h, { orderId: 'order-real-hook', amount: 45_000 });
    assert.equal(await dispatch(new Date()), 1);
    assert.equal(received.length, 1);
    assert.equal(received[0]?.valid, true);
    assert.equal((JSON.parse(received[0]?.body ?? '{}') as { qrId: string }).qrId, paid.qrId);
    const [delivery] = pick((await listDeliveries(h)).body, 'items') as { status: string; eventId: string }[];
    assert.equal(delivery?.status, 'DELIVERED');
    assert.equal(delivery?.eventId, received[0]?.eventId);
  });

  it('ответ 500 и молчание дольше срока — две неудачи подряд, потом успех; в журнале код и ошибка', async () => {
    await setWebhookDirect(h, url, SECRET);
    await payOrder(h, { orderId: 'order-real-retry', amount: 45_000 });
    const t0 = new Date();
    respond = () => ({ status: 500 });
    await dispatch(t0);
    respond = () => ({ status: 200, delayMs: 1500 });
    await dispatch(new Date(t0.getTime() + 10_000));
    respond = () => ({ status: 200 });
    await dispatch(new Date(t0.getTime() + 40_000));
    const [delivery] = pick((await listDeliveries(h)).body, 'items') as { status: string; attempts: { attempt: number; statusCode: number | null; error: string | null }[] }[];
    assert.equal(delivery?.status, 'DELIVERED');
    assert.deepEqual(delivery?.attempts.map((item) => [item.attempt, item.statusCode, item.error]), [[1, 500, null], [2, null, 'TIMEOUT'], [3, 200, null]]);
    assert.equal(received.every((item) => item.valid), true);
    assert.equal(new Set(received.map((item) => item.eventId)).size, 1);
  });

  it('адрес, который ведёт на сам банк, не получает запрос: попытка записана с ошибкой WEBHOOK_URL_LOOPBACK и повторяется по расписанию', async () => {
    await setWebhookDirect(h, `http://[::ffff:127.0.0.1]:${new URL(url).port}/webhook`, SECRET);
    await payOrder(h, { orderId: 'order-real-loopback', amount: 45_000 });
    await dispatchDueWebhooks({ pool: h.pool, clock: h.clock, send: createHttpWebhookSender(300), realNow: () => new Date() });
    assert.equal(received.length, 0);
    const [delivery] = pick((await listDeliveries(h)).body, 'items') as { status: string; attempts: { statusCode: number | null; error: string | null }[] }[];
    assert.equal(delivery?.status, 'PENDING');
    assert.deepEqual(delivery?.attempts.map((item) => [item.statusCode, item.error]), [[null, 'WEBHOOK_URL_LOOPBACK']]);
  });

  it('приёмник с другим секретом отвечает отказом на неверную подпись, банк повторяет', async () => {
    await setWebhookDirect(h, url, 'not-the-receiver-secret');
    await payOrder(h, { orderId: 'order-real-bad-secret', amount: 45_000 });
    respond = () => ({ status: received.at(-1)?.valid ? 200 : 401 });
    await dispatch(new Date());
    assert.equal(received[0]?.valid, false);
    const [delivery] = pick((await listDeliveries(h)).body, 'items') as { status: string; attempts: { statusCode: number }[] }[];
    assert.equal(delivery?.status, 'PENDING');
    assert.equal(delivery?.attempts[0]?.statusCode, 401);
  });
});
