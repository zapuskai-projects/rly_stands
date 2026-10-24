import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, type Harness } from '../testing/harness';
import { issuedQr, issueQr, partnerApi, payQr, readQr, startOnRelease } from '../testing/qr';
import { seedIfEmpty } from '../seed/seed';
import { accountOf, PHONES, useRelease } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA } = PHONES;
const SOME_ID = '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const BASE = { label: 'qr:run-1', defects: [], sbpMode: 'NORMAL', bankTime: null };

describe('партнёрское API магазина на релизе 1.2', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startOnRelease('1.2');
  });

  afterEach(async () => {
    await h.close();
  });

  it('без ключа и с неверным ключом каждый маршрут отвечает 401, с верным работает', async () => {
    const routes: [string, string, unknown?][] = [
      ['POST', '/partner/v1/qr', { orderId: 'order-auth', amount: 1000, description: 'Заказ' }],
      ['GET', `/partner/v1/qr/${SOME_ID}`],
      ['DELETE', `/partner/v1/qr/${SOME_ID}`],
      ['POST', `/partner/v1/qr/${SOME_ID}/refunds`, { amount: 100 }],
      ['PUT', '/partner/v1/webhook', { url: 'http://host.docker.internal:8080/hook', secret: 'secret' }],
      ['GET', '/partner/v1/webhook/deliveries'],
    ];
    for (const [method, route, body] of routes) {
      const missing = await h.api(null, method, route, body);
      assert.equal(missing.status, 401, `${method} ${route}`);
      assert.equal(pick(missing.body, 'code'), 'PARTNER_KEY_REQUIRED');
      const wrong = await h.api(null, method, route, body, { 'X-Partner-Key': 'zbk_test_lavka_wrong' });
      assert.equal(wrong.status, 401);
      assert.equal(pick(wrong.body, 'code'), 'PARTNER_KEY_INVALID');
    }
    assert.equal((await issueQr(h, { orderId: 'order-auth', amount: 1000 })).status, 201);
    const bearer = await h.api(await h.login(ANNA), 'POST', '/partner/v1/qr', { orderId: 'order-bearer', amount: 1000, description: 'Заказ' });
    assert.equal(bearer.status, 401);
  });

  it('магазин появляется и в уже заполненной базе после обновления банка, повторный запуск его не дублирует', async () => {
    await h.pool.query('DELETE FROM partners');
    assert.equal(await seedIfEmpty(h.pool, h.clock), false);
    await seedIfEmpty(h.pool, h.clock);
    const stored = await h.pool.query<{ code: string; commission_bps: number; number: string }>(
      'SELECT p.code, p.commission_bps, c.number FROM partners p JOIN clients c ON c.id = p.client_id',
    );
    assert.deepEqual(stored.rows, [{ code: 'lavka-garipova', commission_bps: 70, number: '10000004' }]);
    assert.equal((await issueQr(h, { orderId: 'order-upgrade', amount: 1000 })).status, 201);
  });

  it('ключ магазина хранится хешем', async () => {
    const stored = await h.pool.query<{ api_key_hash: string }>('SELECT api_key_hash FROM partners');
    assert.equal(stored.rows.length, 1);
    assert.match(stored.rows[0]?.api_key_hash ?? '', /^[0-9a-f]{64}$/);
  });

  it('QR выставляется, повтор с тем же заказом возвращает тот же QR, с другой суммой — 409', async () => {
    const created = await issueQr(h, { orderId: 'order-1', amount: 123_450, description: 'Заказ №1', ttlSeconds: 900 });
    assert.equal(created.status, 201);
    const qrId = String(pick(created.body, 'qrId'));
    assert.equal(pick(created.body, 'payload'), `zbqr://pay?id=${qrId}`);
    assert.equal(pick(created.body, 'status'), 'CREATED');
    assert.equal(pick(created.body, 'expiresAt'), '2026-10-20T12:15:00.000+03:00');
    assert.equal(pick(created.body, 'paidAmount'), 0);
    assert.equal(pick(created.body, 'operationId'), null);

    const again = await issueQr(h, { orderId: 'order-1', amount: 123_450, description: 'Другой текст', ttlSeconds: 60 });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.equal(pick(again.body, 'qrId'), qrId);
    assert.equal(pick(again.body, 'description'), 'Заказ №1');

    const other = await issueQr(h, { orderId: 'order-1', amount: 123_451 });
    assert.equal(other.status, 409);
    assert.equal(pick(other.body, 'code'), 'ORDER_ID_REUSED');
    const count = await h.pool.query('SELECT 1 FROM qr_codes');
    assert.equal(count.rowCount, 1);
  });

  it('срок по умолчанию 600 секунд, неверные поля отвергаются с указанием поля', async () => {
    const created = await partnerApi(h, 'POST', '/partner/v1/qr', { orderId: 'order-default', amount: 1000, description: 'Заказ' });
    assert.equal(pick(created.body, 'expiresAt'), '2026-10-20T12:10:00.000+03:00');
    const bad: [Record<string, unknown>, string][] = [
      [{ orderId: 'o-1', amount: 1000, description: 'З', ttlSeconds: 59 }, 'body.ttlSeconds'],
      [{ orderId: 'o-2', amount: 1000, description: 'З', ttlSeconds: 3601 }, 'body.ttlSeconds'],
      [{ orderId: 'o-3', amount: 0, description: 'З' }, 'body.amount'],
      [{ orderId: 'o-4', amount: 100_000_001, description: 'З' }, 'body.amount'],
      [{ orderId: 'o-5', amount: 10.5, description: 'З' }, 'body.amount'],
      [{ orderId: 'заказ с пробелом', amount: 1000, description: 'З' }, 'body.orderId'],
      [{ orderId: 'o-6', amount: 1000, description: '' }, 'body.description'],
      [{ orderId: 'o-7', amount: 1000, description: '   ' }, 'body.description'],
      [{ orderId: 'o-8', amount: 1000, description: 'З'.repeat(141) }, 'body.description'],
      [{ amount: 1000, description: 'З' }, 'body.orderId'],
    ];
    for (const [body, field] of bad) {
      const response = await partnerApi(h, 'POST', '/partner/v1/qr', body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.ok((pick(response.body, 'details') as { field: string }[]).some((item) => item.field === field), `${JSON.stringify(body)} → ${JSON.stringify(response.body)}`);
    }
    assert.equal((await partnerApi(h, 'POST', '/partner/v1/qr', { orderId: 'o-9', amount: 1000, description: 'З', extra: 1 })).status, 400);
    assert.equal((await partnerApi(h, 'GET', '/partner/v1/qr/не-идентификатор')).status, 400);
  });

  it('оплаченный QR отменить нельзя, неоплаченный отменяется повторно без ошибки, чужой QR не виден', async () => {
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const qr = await issuedQr(h, { orderId: 'order-del', amount: 10_000 });
    assert.equal((await partnerApi(h, 'DELETE', `/partner/v1/qr/${qr.qrId}`)).status, 200);
    assert.equal((await partnerApi(h, 'DELETE', `/partner/v1/qr/${qr.qrId}`)).status, 200);
    assert.equal((await partnerApi(h, 'DELETE', `/partner/v1/qr/${SOME_ID}`)).status, 404);
    assert.equal(pick((await partnerApi(h, 'GET', `/partner/v1/qr/${SOME_ID}`)).body, 'code'), 'QR_NOT_FOUND');

    const paidQr = await issuedQr(h, { orderId: 'order-del-paid', amount: 10_000 });
    await payQr(h, anna, 'pay-del-0001', paidQr.payload, account.id);
    await h.drain();
    const refused = await partnerApi(h, 'DELETE', `/partner/v1/qr/${paidQr.qrId}`);
    assert.equal(refused.status, 409);
    assert.equal(pick(refused.body, 'code'), 'QR_ALREADY_PAID');
    assert.equal(pick((await readQr(h, paidQr.qrId)).body, 'status'), 'PAID');
  });

  it('журнал запросов пишет партнёрские запросы и относит их к текущей задаче без метки в заголовке', async () => {
    assert.equal((await h.kit('POST', '/_kit/scenario', { ...BASE, release: '1.2' })).status, 200);
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const qr = await issuedQr(h, { orderId: 'order-journal', amount: 10_000 });
    const paid = await payQr(h, anna, 'pay-journal-001', qr.payload, account.id);
    await h.drain();
    await readQr(h, qr.qrId);
    await partnerApi(h, 'GET', `/partner/v1/qr/${qr.qrId}`, undefined, {});
    const requests = (await h.kit('GET', '/_kit/facts/requests?label=qr:run-1')).body as { method: string; path: string; status: number; errorCode: string | null; operationId: string | null }[];
    const partner = requests.filter((item) => item.path.startsWith('/partner/v1'));
    assert.deepEqual(partner.map((item) => [item.method, item.path, item.status]), [
      ['POST', '/partner/v1/qr', 201],
      ['GET', `/partner/v1/qr/${qr.qrId}`, 200],
      ['GET', `/partner/v1/qr/${qr.qrId}`, 401],
    ]);
    assert.equal(partner[2]?.errorCode, 'PARTNER_KEY_REQUIRED');
    assert.equal(partner[1]?.operationId, pick(paid.body, 'id'));
    assert.ok(requests.some((item) => item.method === 'POST' && item.path === '/api/v1/qr-payments' && item.status === 201));
    const operations = (await h.kit('GET', '/_kit/facts/operations?label=qr:run-1')).body as { id: string; type: string }[];
    assert.deepEqual(operations.filter((item) => item.type === 'QR_PAYMENT').map((item) => item.id), [pick(paid.body, 'id')]);
  });

  it('сброс банка возвращает магазин и его ключ, QR стираются', async () => {
    await issuedQr(h, { orderId: 'order-reset', amount: 10_000 });
    assert.equal((await h.kit('POST', '/_kit/reset')).status, 200);
    assert.equal((await h.pool.query('SELECT 1 FROM qr_codes')).rowCount, 0);
    assert.equal((await h.pool.query('SELECT 1 FROM partners')).rowCount, 1);
    await useRelease(h, '1.2');
    assert.equal((await issueQr(h, { orderId: 'order-reset', amount: 10_000 })).status, 201);
  });

  it('партнёрский контракт отдаётся, помечен релизом 1.2, Swagger UI открывается', async () => {
    const response = await fetch(`${h.baseUrl}/api/partner-openapi.yaml`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(text.includes('operationId: createPartnerQr'));
    assert.ok(text.includes("x-release: '1.2'"));
    assert.equal(/§|спринт|sprint|заход/i.test(text), false);
    const page = await fetch(`${h.baseUrl}/api/partner-docs/`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('партнёрское API'));
    assert.ok((await (await fetch(`${h.baseUrl}/api/partner-docs/swagger-ui-init.js`)).text()).includes('/api/partner-openapi.yaml'));
    assert.ok((await (await fetch(`${h.baseUrl}/api/docs/swagger-ui-init.js`)).text()).includes('/api/openapi.yaml'));
  });
});
