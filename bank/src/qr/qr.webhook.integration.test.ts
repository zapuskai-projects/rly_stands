import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, type Harness } from '../testing/harness';
import { issuedQr, listDeliveries, partnerApi, payOrder, putWebhook, refundQr, startOnRelease } from '../testing/qr';
import { signWebhook } from '../webhooks/webhook-signature';
import { claimDueDeliveries, recordAttempt } from '../webhooks/webhooks.repository';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const URL = 'http://host.docker.internal:8080/webhook';
const SECRET = 'my-shared-secret';
const T0 = new Date('2026-10-20T09:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

interface Attempt {
  attempt: number;
  statusCode: number | null;
  error: string | null;
}

describe('уведомления магазину на релизе 1.2', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startOnRelease('1.2');
  });

  afterEach(async () => {
    await h.close();
  });

  const deliveries = async (query = '') => (pick((await listDeliveries(h, query)).body, 'items') as Record<string, unknown>[]);
  const attemptsOf = (delivery: Record<string, unknown> | undefined) => (delivery?.attempts as Attempt[]).map((item) => [item.attempt, item.statusCode, item.error]);

  it('адрес и секрет сохраняются, ответ не раскрывает секрет; http и https принимаются, остальное отвергается', async () => {
    const saved = await putWebhook(h, URL, SECRET);
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, { url: URL, secretSet: true });
    assert.equal((await putWebhook(h, 'https://shop.example.com/hook', 'x')).status, 200);
    assert.equal((await putWebhook(h, 'http://unreachable.invalid:9/x', 'x')).status, 200);
    for (const url of ['ftp://host/x', 'host.docker.internal:8080', 'not a url', 'file:///etc/passwd', `http://h/${'a'.repeat(500)}`]) {
      const response = await putWebhook(h, url, SECRET);
      assert.equal(response.status, 400, url);
      assert.ok((pick(response.body, 'details') as { field: string }[]).some((item) => item.field === 'body.url'), url);
    }
    assert.equal((await partnerApi(h, 'PUT', '/partner/v1/webhook', { url: URL })).status, 400);
    assert.equal((await partnerApi(h, 'PUT', '/partner/v1/webhook', { url: URL, secret: '' })).status, 400);
    assert.equal((await partnerApi(h, 'PUT', '/partner/v1/webhook', { url: URL, secret: SECRET }, {})).status, 401);
    const stored = await h.pool.query<{ webhook_url: string; webhook_secret: string }>('SELECT webhook_url, webhook_secret FROM partners');
    assert.equal(stored.rows[0]?.webhook_url, 'http://unreachable.invalid:9/x');
  });

  it('адреса, указывающие на сам банк, отвергаются с кодом WEBHOOK_URL_LOOPBACK и подсказкой, прежний адрес остаётся', async () => {
    await putWebhook(h, URL, SECRET);
    const hosts = ['localhost', 'LOCALHOST', 'localhost.', 'shop.localhost', '127.0.0.1', '127.1.2.3', '127.1', '2130706433', '[::1]', '0.0.0.0'];
    for (const host of hosts) {
      const response = await putWebhook(h, `http://${host}:8080/webhook`, SECRET);
      assert.equal(response.status, 422, host);
      assert.equal(pick(response.body, 'code'), 'WEBHOOK_URL_LOOPBACK', host);
      assert.equal(pick(response.body, 'message'), 'Банк работает в контейнере: адрес localhost для него — он сам. Укажите http://host.docker.internal:<порт>', host);
    }
    assert.equal((await putWebhook(h, 'https://localhost/webhook', SECRET)).status, 422);
    for (const ok of ['http://host.docker.internal:8080/webhook', 'http://128.0.0.1/x', 'http://localhost-shop.example.com/x', 'http://10.0.0.5:8080/x']) {
      assert.equal((await putWebhook(h, ok, SECRET)).status, 200, ok);
    }
    await putWebhook(h, URL, SECRET);
    assert.equal((await putWebhook(h, 'http://localhost:9/x', 'other-secret')).status, 422);
    const stored = await h.pool.query<{ webhook_url: string; webhook_secret: string }>('SELECT webhook_url, webhook_secret FROM partners');
    assert.deepEqual(stored.rows, [{ webhook_url: URL, webhook_secret: SECRET }]);
  });

  it('оплата отправляет qr.paid с подписью и номером события; доставка попадает в журнал', async () => {
    await putWebhook(h, URL, SECRET);
    const paid = await payOrder(h, { orderId: 'order-hook-paid', amount: 123_450 });
    assert.equal(await h.dispatchWebhooks(T0), 1);
    assert.equal(h.webhook.requests.length, 1);
    const request = h.webhook.requests[0];
    assert.equal(request?.url, URL);
    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['event', 'qrId', 'orderId', 'amount', 'refundedAmount', 'operationId', 'occurredAt']);
    assert.equal(body.event, 'qr.paid');
    assert.equal(body.qrId, paid.qrId);
    assert.equal(body.orderId, 'order-hook-paid');
    assert.equal(body.amount, 123_450);
    assert.equal(body.refundedAmount, 0);
    assert.equal(body.operationId, paid.operationId);
    assert.match(String(body.occurredAt), /^2026-10-20T12:00:\d{2}\.\d{3}\+03:00$/);
    assert.equal(request?.headers['X-Signature'], signWebhook(SECRET, request?.body ?? ''));
    assert.match(request?.headers['X-Signature'] ?? '', /^sha256=[0-9a-f]{64}$/);
    assert.equal(request?.headers['Content-Type'], 'application/json');
    const [delivery] = await deliveries();
    assert.equal(request?.headers['X-Event-Id'], delivery?.eventId);
    assert.equal(delivery?.status, 'DELIVERED');
    assert.equal(delivery?.event, 'qr.paid');
    assert.equal(delivery?.url, URL);
    assert.equal(delivery?.attemptsMade, 1);
    assert.equal(delivery?.nextAttemptAt, null);
    assert.deepEqual(attemptsOf(delivery), [[1, 200, null]]);
    assert.equal(await h.dispatchWebhooks(at(1000)), 0);
  });

  it('пока адрес не задан, уведомлений нет; задали позже — прошлые события не отправляются', async () => {
    await payOrder(h, { orderId: 'order-hook-none', amount: 10_000 });
    assert.equal(await h.dispatchWebhooks(T0), 0);
    assert.deepEqual(await deliveries(), []);
    await putWebhook(h, URL, SECRET);
    assert.equal(await h.dispatchWebhooks(at(100)), 0);
    assert.equal(h.webhook.requests.length, 0);
  });

  it('при ошибках повторы через 10, 30 и 60 секунд, всего четыре попытки, потом отправка закончена; номер события и тело те же', async () => {
    await putWebhook(h, URL, SECRET);
    await payOrder(h, { orderId: 'order-hook-retry', amount: 10_000 });
    h.webhook.answers({ kind: 'RESPONSE', status: 500 }, { kind: 'ERROR', error: 'TIMEOUT' }, { kind: 'RESPONSE', status: 503 }, { kind: 'RESPONSE', status: 500 });
    assert.equal(await h.dispatchWebhooks(T0), 1);
    let [delivery] = await deliveries();
    assert.equal(delivery?.status, 'PENDING');
    assert.equal(typeof delivery?.nextAttemptAt, 'string');
    assert.equal(await h.dispatchWebhooks(at(9)), 0);
    assert.equal(await h.dispatchWebhooks(at(10)), 1);
    assert.equal(await h.dispatchWebhooks(at(10 + 29)), 0);
    assert.equal(await h.dispatchWebhooks(at(10 + 30)), 1);
    assert.equal(await h.dispatchWebhooks(at(40 + 59)), 0);
    [delivery] = await deliveries();
    assert.equal(delivery?.status, 'PENDING');
    assert.equal(await h.dispatchWebhooks(at(40 + 60)), 1);
    [delivery] = await deliveries();
    assert.equal(delivery?.status, 'FAILED');
    assert.equal(delivery?.attemptsMade, 4);
    assert.equal(delivery?.nextAttemptAt, null);
    assert.deepEqual(attemptsOf(delivery), [[1, 500, null], [2, null, 'TIMEOUT'], [3, 503, null], [4, 500, null]]);
    assert.equal(await h.dispatchWebhooks(at(100_000)), 0);
    assert.equal(h.webhook.requests.length, 4);
    assert.equal(new Set(h.webhook.requests.map((request) => request.headers['X-Event-Id'])).size, 1);
    assert.equal(new Set(h.webhook.requests.map((request) => request.body)).size, 1);
    assert.equal(new Set(h.webhook.requests.map((request) => request.headers['X-Signature'])).size, 1);
  });

  it('успех на третьей попытке закрывает доставку, дальше отправок нет', async () => {
    await putWebhook(h, URL, SECRET);
    await payOrder(h, { orderId: 'order-hook-third', amount: 10_000 });
    h.webhook.answers({ kind: 'RESPONSE', status: 502 }, { kind: 'ERROR', error: 'ECONNREFUSED' });
    await h.dispatchWebhooks(T0);
    await h.dispatchWebhooks(at(10));
    await h.dispatchWebhooks(at(40));
    const [delivery] = await deliveries();
    assert.equal(delivery?.status, 'DELIVERED');
    assert.deepEqual(attemptsOf(delivery), [[1, 502, null], [2, null, 'ECONNREFUSED'], [3, 200, null]]);
    assert.equal(await h.dispatchWebhooks(at(500)), 0);
  });

  it('любой не-2xx код, в том числе перенаправление, считается неудачей', async () => {
    await putWebhook(h, URL, SECRET);
    await payOrder(h, { orderId: 'order-hook-codes', amount: 10_000 });
    h.webhook.answers({ kind: 'RESPONSE', status: 302 }, { kind: 'RESPONSE', status: 404 }, { kind: 'RESPONSE', status: 204 });
    await h.dispatchWebhooks(T0);
    await h.dispatchWebhooks(at(10));
    await h.dispatchWebhooks(at(40));
    const [delivery] = await deliveries();
    assert.deepEqual(attemptsOf(delivery), [[1, 302, null], [2, 404, null], [3, 204, null]]);
    assert.equal(delivery?.status, 'DELIVERED');
  });

  it('два цикла отправки подряд не шлют одно уведомление дважды', async () => {
    await putWebhook(h, URL, SECRET);
    await payOrder(h, { orderId: 'order-hook-twice', amount: 10_000 });
    const sent = await Promise.all([h.dispatchWebhooks(T0), h.dispatchWebhooks(T0)]);
    assert.equal(sent[0] + sent[1], 1);
    assert.equal(h.webhook.requests.length, 1);
  });

  it('возвраты отправляют qr.refunded с накопленной суммой и операцией возврата', async () => {
    await putWebhook(h, URL, SECRET);
    const paid = await payOrder(h, { orderId: 'order-hook-refund', amount: 100_000 });
    const first = await refundQr(h, paid.qrId, 30_000, 'refund-hook-0001');
    const second = await refundQr(h, paid.qrId, 20_000, 'refund-hook-0002');
    await h.dispatchWebhooks(T0);
    const bodies = h.webhook.requests.map((request) => JSON.parse(request.body) as Record<string, unknown>);
    assert.deepEqual(bodies.map((body) => body.event).sort(), ['qr.paid', 'qr.refunded', 'qr.refunded']);
    const refunds = bodies.filter((body) => body.event === 'qr.refunded');
    assert.deepEqual(refunds.map((body) => [body.operationId, body.refundedAmount, body.amount]).sort(), [
      [pick(first.body, 'operationId'), 30_000, 100_000],
      [pick(second.body, 'operationId'), 50_000, 100_000],
    ].sort());
    const request = h.webhook.requests.find((item) => (JSON.parse(item.body) as { event: string }).event === 'qr.refunded');
    assert.equal(request?.headers['X-Signature'], signWebhook(SECRET, request?.body ?? ''));
    assert.deepEqual((await deliveries('?event=qr.refunded')).map((item) => item.event), ['qr.refunded', 'qr.refunded']);
  });

  it('запись попытки атомарна: при сбое не остаётся ни попытки, ни сдвига счётчика, повторный захват записывает ту же попытку', async () => {
    await putWebhook(h, URL, SECRET);
    await payOrder(h, { orderId: 'order-hook-atomic', amount: 10_000 });
    const [claimed] = await claimDueDeliveries(h.pool, T0, 15_000, 10);
    assert.ok(claimed);
    const outcome = { at: T0, statusCode: 500, error: null, durationMs: 3 };
    await assert.rejects(recordAttempt(h.pool, claimed, outcome, { status: 'BROKEN' as 'PENDING', nextAttemptAt: at(10), finishedAt: null }));
    assert.equal((await h.pool.query('SELECT 1 FROM webhook_attempts')).rowCount, 0);
    assert.equal((await h.pool.query<{ attempts_made: number }>('SELECT attempts_made FROM webhook_deliveries')).rows[0]?.attempts_made, 0);
    const [again] = await claimDueDeliveries(h.pool, at(16), 15_000, 10);
    assert.ok(again);
    await recordAttempt(h.pool, again, outcome, { status: 'PENDING', nextAttemptAt: at(26), finishedAt: null });
    const [delivery] = await deliveries();
    assert.deepEqual(attemptsOf(delivery), [[1, 500, null]]);
    assert.equal(delivery?.attemptsMade, 1);
  });

  it('журнал: фильтры по QR и событию, постраничность, новые сверху', async () => {
    await putWebhook(h, URL, SECRET);
    const one = await payOrder(h, { orderId: 'order-hook-list-1', amount: 10_000 });
    const two = await payOrder(h, { orderId: 'order-hook-list-2', amount: 10_000 });
    await refundQr(h, two.qrId, 5_000, 'refund-list-00001');
    await h.dispatchWebhooks(T0);
    const all = await listDeliveries(h);
    assert.equal(pick(all.body, 'total'), 3);
    assert.equal(pick(all.body, 'limit'), 20);
    assert.equal(((await deliveries('?qrId=' + one.qrId)).map((item) => item.qrId)).every((id) => id === one.qrId), true);
    assert.equal((await deliveries(`?qrId=${two.qrId}`)).length, 2);
    assert.equal((await deliveries('?limit=1')).length, 1);
    assert.equal((await deliveries('?limit=1&offset=2')).length, 1);
    assert.equal((await deliveries('?offset=3')).length, 0);
    assert.equal((await listDeliveries(h, '?limit=0')).status, 400);
    assert.equal((await listDeliveries(h, '?event=qr.other')).status, 400);
    assert.equal((await listDeliveries(h, '?qrId=нет')).status, 400);
    assert.equal((await partnerApi(h, 'GET', '/partner/v1/webhook/deliveries', undefined, {})).status, 401);
  });

  it('журнал показывает только уведомления по оплаченным QR, а после сброса банка пуст', async () => {
    await putWebhook(h, URL, SECRET);
    await payOrder(h, { orderId: 'order-hook-reset', amount: 10_000 });
    await issuedQr(h, { orderId: 'order-hook-open', amount: 10_000 });
    assert.equal((await deliveries()).length, 1);
    await h.kit('POST', '/_kit/reset');
    assert.equal((await h.pool.query('SELECT 1 FROM webhook_deliveries')).rowCount, 0);
  });
});
