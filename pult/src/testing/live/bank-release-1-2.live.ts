import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, it } from 'node:test';
import { READINESS } from '../../modules/readiness';
import { eventually, liveSuite, type LiveEnv } from './support';

type Facts = Record<string, any>;

const ANNA = '+79001110001';
const PETR = '+79001110002';
const SECRET = 'live-shop-secret';
const DEAD_HOOK = 'http://host.docker.internal:9/hook';
const FINAL = new Set(['COMPLETED', 'REJECTED', 'FAILED', 'REFUNDED']);

let counter = 0;
const key = () => `live-qr-${Date.now()}-${(counter += 1)}`;
const order = () => `order-${Date.now()}-${(counter += 1)}`;

async function settled(env: LiveEnv, id: string) {
  return eventually(
    () => env.probe<Facts>('bank.operation', { id }),
    (value) => value.exists === true && FINAL.has(value.status),
    20_000,
    400,
  );
}

liveSuite('bank', READINESS.bank ?? [], 'ЗапускБанк 1.2: оплата по QR, возвраты, уведомления и сбои на живом банке', (env) => {
  const { probe } = env;

  before(() => {
    writeFileSync(join(env.dataDir(), 'bank-secret'), `${process.env.KIT_LIVE_BANK_SECRET ?? ''}\n`);
  });

  const scenario = (params: Record<string, unknown>) => probe('bank.scenario', { reset: true, bankTime: 'noon', release: '1.2', ...params });
  const shop = (method: string, path: string, body?: Record<string, unknown>, headers?: Record<string, string>) =>
    probe<Facts>('bank.partnerHttp', { method, path, ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });
  const bank = (asPhone: string, method: string, path: string, body?: Record<string, unknown>, headers?: Record<string, string>) =>
    probe<Facts>('bank.http', { asPhone, method, path, ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });
  const createQr = (amount: number, extra: Record<string, unknown> = {}) =>
    shop('POST', '/partner/v1/qr', { orderId: order(), amount, description: 'Заказ', ttlSeconds: 600, ...extra });
  const pay = async (phone: string, payload: string) => {
    const accounts = await bank(phone, 'GET', '/api/v1/accounts');
    return bank(phone, 'POST', '/api/v1/qr-payments', { payload, accountId: accounts.firstId }, { 'Idempotency-Key': key() });
  };

  it('до релиза 1.2 факты QR и доставок недоступны с понятной ошибкой, партнёрский вызов — 404', async () => {
    await scenario({ defects: [], release: '1.1' });
    await assert.rejects(probe('bank.qrCodes', {}), /доступна с релиза 1\.2/);
    await assert.rejects(probe('bank.webhookDeliveries', {}), /доступны с релиза 1\.2/);
    assert.equal((await createQr(100_000)).status, 404);
    await scenario({ defects: [] });
    assert.deepEqual([(await probe<Facts>('bank.qrCodes', {})).count, (await probe<Facts>('bank.webhookDeliveries', {})).count], [0, 0]);
  });

  it('оплата и возврат: bank.qrCodes считает зачисленное, комиссию и возвращённое, книга сходится, results qrId и firstId', async () => {
    await scenario({ defects: [] });
    const qr = await createQr(1_000_000);
    assert.equal(qr.status, 201);
    assert.match(qr.payload, /^zbqr:\/\/pay\?id=/);
    const paid = await pay(ANNA, qr.payload);
    assert.equal(paid.status, 201);
    assert.equal(paid.qrId, qr.qrId);
    await settled(env, paid.id);
    const first = await shop('POST', `/partner/v1/qr/${qr.qrId}/refunds`, { amount: 300_000 }, { 'Idempotency-Key': key() });
    const second = await shop('POST', `/partner/v1/qr/${qr.qrId}/refunds`, { amount: 700_000 }, { 'Idempotency-Key': key() });
    const over = await shop('POST', `/partner/v1/qr/${qr.qrId}/refunds`, { amount: 100 }, { 'Idempotency-Key': key() });
    assert.deepEqual([first.status, first.qrStatus, second.status, second.qrStatus, over.status, over.code], [201, 'PARTIALLY_REFUNDED', 201, 'REFUNDED', 422, 'REFUND_EXCEEDS_PAYMENT']);
    const facts = await probe<Facts>('bank.qrCodes', { label: env.label });
    assert.deepEqual(
      [facts.count, facts.refundedCount, facts.totalAmountKop, facts.totalCreditedKop, facts.totalCommissionKop, facts.totalRefundedKop],
      [1, 1, 1_000_000, 993_000, 7_000, 1_000_000],
    );
    assert.equal(facts.qrCodes[0].payerPhone, ANNA);
    assert.equal(facts.qrCodes[0].refunds.length, 2);
    assert.deepEqual((await probe<Facts>('bank.ledger', {})).inconsistent, []);
    const log = await probe<Facts>('bank.requestLog', { label: env.label });
    assert.ok(log.requests.find((item: Facts) => item.route === '/partner/v1/qr/{id}/refunds' && item.status === 422));
    assert.ok(log.requests.find((item: Facts) => item.route === '/api/v1/qr-payments' && item.statusClass === '2xx'));
  });

  it('уведомление на недоступный адрес: четыре попытки с паузами 10, 30, 60 с и ошибкой соединения', async () => {
    await scenario({ defects: [] });
    assert.equal((await shop('PUT', '/partner/v1/webhook', { url: DEAD_HOOK, secret: SECRET })).status, 200);
    const qr = await createQr(249_000);
    await pay(ANNA, qr.payload);
    const done = await eventually(
      () => probe<Facts>('bank.webhookDeliveries', { label: env.label, qrId: qr.qrId }),
      (value) => value.failedCount >= 1,
      150_000,
      2_000,
    );
    const delivery = done.deliveries[0];
    assert.deepEqual([delivery.status, delivery.attemptsMade, done.maxAttempts, done.retriedCount], ['FAILED', 4, 4, 1]);
    assert.ok(delivery.attempts.length === 4 && delivery.attempts.every((item: Facts) => item.statusCode === null && ['ECONNREFUSED', 'NETWORK_ERROR'].includes(item.error)));
    assert.deepEqual(delivery.gapsSec.map((value: number) => Math.round(value / 10)), [1, 3, 6]);
    assert.equal(delivery.url, DEAD_HOOK);
  });

  it('loopback в адресе уведомлений отклонён с подсказкой про host.docker.internal', async () => {
    await scenario({ defects: [] });
    const refused = await shop('PUT', '/partner/v1/webhook', { url: 'http://localhost:8080/hook', secret: SECRET });
    assert.deepEqual([refused.status, refused.code], [422, 'WEBHOOK_URL_LOOPBACK']);
  });

  it('qr-double-payment: второй клиент платит оплаченный QR — проведено с пометкой; без сбоя 409 QR_ALREADY_PAID', async () => {
    await scenario({ defects: ['qr-double-payment'] });
    const qr = await createQr(100_000);
    const first = await pay(ANNA, qr.payload);
    await settled(env, first.id);
    const second = await pay(PETR, qr.payload);
    assert.equal(second.status, 201);
    const operation = await settled(env, second.id);
    assert.deepEqual([operation.status, operation.defects.map((item: Facts) => item.code)], ['COMPLETED', ['qr-double-payment']]);
    const facts = await probe<Facts>('bank.operations', { label: env.label });
    const codesOf = (id: string) => facts.operations.find((item: Facts) => item.id === id)?.defectCodes;
    assert.deepEqual([codesOf(first.id), codesOf(second.id)], [[], ['qr-double-payment']]);
    await scenario({ defects: [] });
    const clean = await createQr(100_000);
    await settled(env, (await pay(ANNA, clean.payload)).id);
    const refused = await pay(PETR, clean.payload);
    assert.deepEqual([refused.status, refused.code], [409, 'QR_ALREADY_PAID']);
  });

  it('qr-expired-accepted: просроченный QR оплачен с пометкой; без сбоя 409 QR_EXPIRED', async () => {
    await scenario({ defects: ['qr-expired-accepted'] });
    const qr = await createQr(100_000, { ttlSeconds: 60 });
    await probe('bank.scenario', { release: '1.2', defects: ['qr-expired-accepted'], bankTime: 'noon+120m' });
    const paid = await pay(ANNA, qr.payload);
    assert.equal(paid.status, 201);
    const operation = await settled(env, paid.id);
    assert.deepEqual([operation.status, operation.defects.map((item: Facts) => item.code)], ['COMPLETED', ['qr-expired-accepted']]);
    await scenario({ defects: [] });
    const clean = await createQr(100_000, { ttlSeconds: 60 });
    await probe('bank.scenario', { release: '1.2', defects: [], bankTime: 'noon+120m' });
    const refused = await pay(ANNA, clean.payload);
    assert.deepEqual([refused.status, refused.code], [409, 'QR_EXPIRED']);
  });

  it('refund-over-amount: возвраты сверх оплаты проходят с пометкой на операции возврата; без сбоя — 422', async () => {
    await scenario({ defects: ['refund-over-amount'] });
    const qr = await createQr(100_000);
    await settled(env, (await pay(ANNA, qr.payload)).id);
    const refund = (amount: number) => shop('POST', `/partner/v1/qr/${qr.qrId}/refunds`, { amount }, { 'Idempotency-Key': key() });
    assert.equal((await refund(70_000)).status, 201);
    const over = await refund(70_000);
    assert.deepEqual([over.status, over.qrStatus], [201, 'REFUNDED']);
    const facts = await probe<Facts>('bank.operations', { label: env.label });
    const marked = facts.operations.filter((item: Facts) => item.defectCodes.includes('refund-over-amount'));
    assert.equal(marked.length, 1);
    assert.equal(marked[0].type, 'QR_REFUND');
    await scenario({ defects: [] });
    const clean = await createQr(100_000);
    await settled(env, (await pay(ANNA, clean.payload)).id);
    await shop('POST', `/partner/v1/qr/${clean.qrId}/refunds`, { amount: 70_000 }, { 'Idempotency-Key': key() });
    const refused = await shop('POST', `/partner/v1/qr/${clean.qrId}/refunds`, { amount: 70_000 }, { 'Idempotency-Key': key() });
    assert.deepEqual([refused.status, refused.code], [422, 'REFUND_EXCEEDS_PAYMENT']);
  });

  it('webhook-no-retry: одна попытка и пометка на доставке, без сбоя — четыре попытки', async () => {
    await scenario({ defects: ['webhook-no-retry'] });
    await shop('PUT', '/partner/v1/webhook', { url: DEAD_HOOK, secret: SECRET });
    const qr = await createQr(100_000);
    await pay(ANNA, qr.payload);
    const done = await eventually(
      () => probe<Facts>('bank.webhookDeliveries', { label: env.label, qrId: qr.qrId }),
      (value) => value.deliveries.length > 0 && value.deliveries[0].attemptsMade >= 1,
      30_000,
      1_000,
    );
    assert.equal(done.deliveries[0].status, 'FAILED');
    assert.deepEqual([done.deliveries[0].attemptsMade, done.defectiveCount, done.deliveries[0].defectCodes], [1, 1, ['webhook-no-retry']]);
    await scenario({ defects: [] });
    await shop('PUT', '/partner/v1/webhook', { url: DEAD_HOOK, secret: SECRET });
    const clean = await createQr(100_000);
    await pay(ANNA, clean.payload);
    const early = await eventually(
      () => probe<Facts>('bank.webhookDeliveries', { label: env.label, qrId: clean.qrId }),
      (value) => value.deliveries.length > 0 && value.deliveries[0].attemptsMade >= 1,
      15_000,
      500,
    );
    assert.deepEqual([early.deliveries[0].status, early.defectiveCount], ['PENDING', 0]);
  });
});
