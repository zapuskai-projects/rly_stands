import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { LAVKA_PARTNER_KEY } from '../partners/partner-key';
import { pick, type Harness } from '../testing/harness';
import { issuedQr, payQr, startOnRelease } from '../testing/qr';
import { accountOf, PHONES, useRelease } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA } = PHONES;
const SOME_ID = '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

describe('релиз 1.2: QR и партнёрское API не видны на 1.0 и 1.1', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  afterEach(async () => {
    await h.close();
  });

  for (const release of ['1.0', '1.1'] as const) {
    it(`релиз ${release}: все маршруты, контракты, документация и спецификации без следов QR`, async () => {
      h = await startOnRelease(release);
      const anna = await h.login(ANNA);
      const partnerRoutes: [string, string, unknown?][] = [
        ['POST', '/partner/v1/qr', { orderId: 'order-0001', amount: 1000, description: 'Заказ' }],
        ['GET', `/partner/v1/qr/${SOME_ID}`],
        ['DELETE', `/partner/v1/qr/${SOME_ID}`],
        ['POST', `/partner/v1/qr/${SOME_ID}/refunds`, { amount: 100 }],
        ['PUT', '/partner/v1/webhook', { url: 'http://host.docker.internal:8080/hook', secret: 'secret' }],
        ['GET', '/partner/v1/webhook/deliveries'],
      ];
      for (const [method, route, body] of partnerRoutes) {
        for (const headers of [{}, { 'X-Partner-Key': 'zbk_wrong_key' }, { 'X-Partner-Key': LAVKA_PARTNER_KEY }] as Record<string, string>[]) {
          const response = await h.api(null, method, route, body, headers);
          assert.equal(response.status, 404, `${method} ${route}`);
          assert.equal(pick(response.body, 'code'), 'NOT_FOUND', `${method} ${route}`);
        }
      }
      const clientRoutes: [string, string, unknown?][] = [
        ['POST', '/api/v1/qr-payments', { payload: 'zbqr://pay?id=' + SOME_ID, accountId: SOME_ID }],
        ['GET', `/api/v1/qr-payments/lookup?payload=${encodeURIComponent(`zbqr://pay?id=${SOME_ID}`)}`],
      ];
      for (const [method, route, body] of clientRoutes) {
        const response = await h.api(anna, method, route, body, { 'Idempotency-Key': 'qr-gate-key-0001' });
        assert.equal(response.status, 404, `${method} ${route}`);
        assert.equal(pick(response.body, 'code'), 'NOT_FOUND', `${method} ${route}`);
      }
      for (const route of ['/api/partner-openapi.yaml', '/api/partner-docs/', '/api/partner-docs/swagger-ui-init.js']) {
        assert.equal((await fetch(`${h.baseUrl}${route}`)).status, 404, route);
      }
      for (const route of ['/api/openapi.yaml', '/api/asyncapi.yaml']) {
        const text = await (await fetch(`${h.baseUrl}${route}`)).text();
        assert.equal(/qr|партнёр|partner|1\.2/i.test(text), false, route);
      }
      const specs = ((await (await fetch(`${h.baseUrl}/docs-content`)).json()) as { specs: { id: string }[] }).specs;
      assert.deepEqual(specs.map((item) => item.id), ['openapi', 'asyncapi']);
    });
  }

  it('на 1.2 QR появляется, а после возврата на 1.0 оплаты по QR исчезают из истории клиента и офиса', async () => {
    h = await startOnRelease('1.2');
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const qr = await issuedQr(h, { orderId: 'order-visible', amount: 50_000 });
    const paid = await payQr(h, anna, 'pay-visible-0001', qr.payload, account.id);
    assert.equal(paid.status, 201);
    await h.drain();
    const operationId = String(pick(paid.body, 'id'));
    const operator = await h.operatorLogin();

    const types = async () => (pick((await h.api(anna, 'GET', '/api/v1/operations')).body, 'items') as { type: string }[]).map((item) => item.type);
    assert.ok((await types()).includes('QR_PAYMENT'));
    assert.equal((await h.api(operator, 'GET', `/api/v1/office/operations/${operationId}`)).status, 200);
    const specs = ((await (await fetch(`${h.baseUrl}/docs-content`)).json()) as { specs: { id: string }[] }).specs;
    assert.ok(specs.some((item) => item.id === 'partner-openapi'));

    await useRelease(h, '1.0');
    assert.equal((await types()).includes('QR_PAYMENT'), false);
    assert.equal((await h.api(anna, 'GET', `/api/v1/operations/${operationId}`)).status, 404);
    assert.equal((await h.api(anna, 'GET', '/api/v1/operations?type=QR_PAYMENT')).status, 400);
    assert.equal((await h.api(operator, 'GET', `/api/v1/office/operations/${operationId}`)).status, 404);
    const office = await h.api(operator, 'GET', '/api/v1/office/operations?limit=100');
    assert.equal((pick(office.body, 'items') as { type: string }[]).some((item) => item.type === 'QR_PAYMENT'), false);
  });
});
