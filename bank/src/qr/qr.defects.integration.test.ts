import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { listDefectMarks, loadActiveDefects } from '../defects/defects.repository';
import { pick, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { listDeliveries, issuedQr, payOrder, payQr, putWebhook, readQr, refundQr, startOnRelease } from '../testing/qr';
import { accountOf, NOON_MOSCOW, PHONES, setDefects } from '../testing/scenarios';
import { expireQrCodes } from './qr-sweep';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const URL = 'http://host.docker.internal:8080/webhook';
const T0 = new Date('2026-10-20T09:00:00Z');
const BASE = { label: 'defects:run-1', sbpMode: 'NORMAL', bankTime: null, release: '1.2' };

describe('дефекты релиза 1.2, включаемые сценарием', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startOnRelease('1.2');
  });

  afterEach(async () => {
    await h.close();
  });

  const marksOf = async (operationId: string) => (await listDefectMarks(h.pool, operationId)).map((mark) => [mark.code, mark.details] as const);

  describe('qr-double-payment', () => {
    it('без сбоя вторая оплата того же QR отклоняется, и вторым клиентом, и тем же клиентом с другим ключом, пометок нет', async () => {
      const paid = await payOrder(h, { orderId: 'order-dbl-off', amount: 10_000 });
      const petr = await h.login(PETR);
      assert.equal((await payQr(h, petr, 'dbl-off-0001', paid.payload, (await accountOf(h, petr)).id)).status, 409);
      assert.equal((await payQr(h, paid.token, 'dbl-off-0002', paid.payload, paid.accountId)).status, 409);
      assert.equal((await h.pool.query('SELECT 1 FROM defect_marks')).rowCount, 0);
    });

    it('со сбоем второй клиент и тот же клиент с другим ключом платят тот же QR: операции проходят, пометка только на повторных', async () => {
      await setDefects(h, ['qr-double-payment']);
      const paid = await payOrder(h, { orderId: 'order-dbl-on', amount: 10_000 });
      assert.deepEqual(await marksOf(paid.operationId), []);
      const petr = await h.login(PETR);
      const second = await payQr(h, petr, 'dbl-on-0001', paid.payload, (await accountOf(h, petr)).id);
      const third = await payQr(h, paid.token, 'dbl-on-0002', paid.payload, paid.accountId);
      assert.equal(second.status, 201);
      assert.equal(third.status, 201);
      await h.drain();
      assert.deepEqual(await marksOf(String(pick(second.body, 'id'))), [
        ['qr-double-payment', { expected: 'QR_ALREADY_PAID', actual: 'ACCEPTED', qrId: paid.qrId, firstOperationId: paid.operationId, firstOperationNumber: pick((await readQr(h, paid.qrId)).body, 'operationNumber'), firstStatus: 'PAID' }],
      ]);
      assert.equal((await marksOf(String(pick(third.body, 'id'))))[0]?.[0], 'qr-double-payment');
      assert.equal(pick((await h.api(petr, 'GET', `/api/v1/operations/${String(pick(second.body, 'id'))}`)).body, 'status'), 'COMPLETED');
      assert.equal(pick((await h.api(paid.token, 'GET', `/api/v1/operations/${String(pick(third.body, 'id'))}`)).body, 'status'), 'COMPLETED');
      const state = await readQr(h, paid.qrId);
      assert.equal(pick(state.body, 'status'), 'PAID');
      assert.equal(pick(state.body, 'operationId'), paid.operationId);
      const total = await h.pool.query<{ total: bigint }>("SELECT COUNT(*) AS total FROM operations WHERE type = 'QR_PAYMENT' AND status = 'COMPLETED'");
      assert.equal(total.rows[0]?.total, 3n);
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
      const facts = (await h.kit('GET', `/_kit/facts/operations/${String(pick(second.body, 'id'))}`)).body as { defects: { code: string }[]; type: string };
      assert.deepEqual(facts.defects.map((item) => item.code), ['qr-double-payment']);
    });

    it('со сбоем оплата, которая ждёт ручной проверки, не мешает второй: пометка называет первую оплату ожидающей', async () => {
      await setDefects(h, ['qr-double-payment']);
      await h.pool.query('UPDATE antifraud_settings SET review_threshold = 1, reject_threshold = 100');
      const qr = await issuedQr(h, { orderId: 'order-dbl-review', amount: 10_000 });
      const anna = await h.login(ANNA);
      const first = await payQr(h, anna, 'dbl-rev-0001', qr.payload, (await accountOf(h, anna)).id);
      await h.drain();
      assert.equal(pick((await h.api(anna, 'GET', `/api/v1/operations/${String(pick(first.body, 'id'))}`)).body, 'status'), 'ON_REVIEW');
      const petr = await h.login(PETR);
      const second = await payQr(h, petr, 'dbl-rev-0002', qr.payload, (await accountOf(h, petr)).id);
      assert.equal(second.status, 201);
      const [mark] = await marksOf(String(pick(second.body, 'id')));
      assert.equal(mark?.[1].firstStatus, 'PENDING');
      assert.equal(mark?.[1].firstOperationId, pick(first.body, 'id'));
    });

    it('включённый сбой не мешает первой оплате и не отменяет другие отказы: отменённый QR по-прежнему не оплачивается', async () => {
      await setDefects(h, ['qr-double-payment']);
      const qr = await issuedQr(h, { orderId: 'order-dbl-cancel', amount: 10_000 });
      const anna = await h.login(ANNA);
      const account = await accountOf(h, anna);
      await h.api(null, 'DELETE', `/partner/v1/qr/${qr.qrId}`, undefined, { 'X-Partner-Key': 'zbk_test_lavka_7f3a91c4e2d85b60a1c9' });
      const refused = await payQr(h, anna, 'dbl-cancel-001', qr.payload, account.id);
      assert.equal(pick(refused.body, 'code'), 'QR_CANCELLED');
      assert.equal((await h.pool.query('SELECT 1 FROM defect_marks')).rowCount, 0);
    });
  });

  describe('qr-expired-accepted', () => {
    it('без сбоя просроченный QR отклоняется', async () => {
      const qr = await issuedQr(h, { orderId: 'order-exp-off', amount: 10_000, ttlSeconds: 60 });
      const anna = await h.login(ANNA);
      h.setTime(new Date(NOON_MOSCOW.getTime() + 61_000));
      const refused = await payQr(h, anna, 'exp-off-0001', qr.payload, (await accountOf(h, anna)).id);
      assert.equal(pick(refused.body, 'code'), 'QR_EXPIRED');
      assert.equal((await h.pool.query('SELECT 1 FROM defect_marks')).rowCount, 0);
    });

    it('со сбоем просроченный QR принимается, в том числе уже помеченный в базе как EXPIRED; QR становится PAID, пометка с числом секунд просрочки', async () => {
      await setDefects(h, ['qr-expired-accepted']);
      const qr = await issuedQr(h, { orderId: 'order-exp-on', amount: 10_000, ttlSeconds: 60 });
      const anna = await h.login(ANNA);
      const account = await accountOf(h, anna);
      h.setTime(new Date(NOON_MOSCOW.getTime() + 125_000));
      assert.equal(await expireQrCodes(h.deps), 1);
      assert.equal(pick((await readQr(h, qr.qrId)).body, 'status'), 'EXPIRED');
      const paid = await payQr(h, anna, 'exp-on-0001', qr.payload, account.id);
      assert.equal(paid.status, 201);
      await h.drain();
      assert.equal(pick((await h.api(anna, 'GET', `/api/v1/operations/${String(pick(paid.body, 'id'))}`)).body, 'status'), 'COMPLETED');
      assert.deepEqual(await marksOf(String(pick(paid.body, 'id'))), [
        ['qr-expired-accepted', { expected: 'QR_EXPIRED', actual: 'ACCEPTED', qrId: qr.qrId, expiresAt: '2026-10-20T12:01:00.000+03:00', secondsAfterExpiry: 65 }],
      ]);
      assert.equal(pick((await readQr(h, qr.qrId)).body, 'status'), 'PAID');
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
    });

    it('со сбоем QR в пределах срока оплачивается без пометки, отменённый и уже оплаченный отказывают как обычно', async () => {
      await setDefects(h, ['qr-expired-accepted']);
      const paid = await payOrder(h, { orderId: 'order-exp-fresh', amount: 10_000 });
      assert.deepEqual(await marksOf(paid.operationId), []);
      const again = await payQr(h, paid.token, 'exp-fresh-0003', paid.payload, paid.accountId);
      assert.equal(again.status, 409);
      assert.equal(pick(again.body, 'code'), 'QR_ALREADY_PAID');
    });
  });

  describe('refund-over-amount', () => {
    it('без сбоя возвраты сверх оплаты отклоняются, пометок нет', async () => {
      const paid = await payOrder(h, { orderId: 'order-over-off', amount: 100_000 });
      assert.equal((await refundQr(h, paid.qrId, 60_000, 'over-off-00001')).status, 201);
      const over = await refundQr(h, paid.qrId, 60_000, 'over-off-00002');
      assert.equal(over.status, 422);
      assert.equal(pick(over.body, 'code'), 'REFUND_EXCEEDS_PAYMENT');
      assert.equal((await h.pool.query('SELECT 1 FROM defect_marks')).rowCount, 0);
    });

    it('со сбоем второй частичный возврат проходит сверх оплаты: пометка только на нём, QR становится REFUNDED, книга сходится', async () => {
      await setDefects(h, ['refund-over-amount']);
      const paid = await payOrder(h, { orderId: 'order-over-on', amount: 100_000 });
      const first = await refundQr(h, paid.qrId, 60_000, 'over-on-00001');
      const second = await refundQr(h, paid.qrId, 60_000, 'over-on-00002');
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      assert.deepEqual(await marksOf(String(pick(first.body, 'operationId'))), []);
      assert.deepEqual(await marksOf(String(pick(second.body, 'operationId'))), [
        ['refund-over-amount', { expected: 'REFUND_EXCEEDS_PAYMENT', actual: 'ACCEPTED', qrId: paid.qrId, paidAmount: 100_000, refundedBefore: 60_000, requested: 60_000, refundedAfter: 120_000 }],
      ]);
      const state = await readQr(h, paid.qrId);
      assert.equal(pick(state.body, 'status'), 'REFUNDED');
      assert.equal(pick(state.body, 'refundedAmount'), 120_000);
      assert.equal(pick(state.body, 'paidAmount'), 100_000);
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
      const facts = (await h.kit('GET', `/_kit/facts/qr?qrId=${paid.qrId}`)).body as { refundedKop: number; remainingKop: number }[];
      assert.deepEqual([facts[0]?.refundedKop, facts[0]?.remainingKop], [120_000, 0]);
    });

    it('со сбоем возврат ровно остатка проходит без пометки, а возврат по полностью возвращённому QR — с пометкой', async () => {
      await setDefects(h, ['refund-over-amount']);
      const paid = await payOrder(h, { orderId: 'order-over-exact', amount: 100_000 });
      const exact = await refundQr(h, paid.qrId, 100_000, 'over-exact-0001');
      assert.deepEqual(await marksOf(String(pick(exact.body, 'operationId'))), []);
      const more = await refundQr(h, paid.qrId, 1, 'over-exact-0002');
      assert.equal(more.status, 201);
      assert.equal((await marksOf(String(pick(more.body, 'operationId'))))[0]?.[0], 'refund-over-amount');
    });

    it('сбой не отменяет другие правила возврата: неоплаченный QR и нехватка денег у магазина отказывают', async () => {
      await setDefects(h, ['refund-over-amount']);
      const open = await issuedQr(h, { orderId: 'order-over-unpaid', amount: 10_000 });
      assert.equal((await refundQr(h, open.qrId, 100, 'over-unpaid-001')).status, 409);
      const paid = await payOrder(h, { orderId: 'order-over-poor', amount: 50_000 });
      await h.pool.query("UPDATE accounts SET balance_kop = 1000 WHERE kind = 'SETTLEMENT'");
      assert.equal(pick((await refundQr(h, paid.qrId, 30_000, 'over-poor-0001')).body, 'code'), 'INSUFFICIENT_FUNDS');
    });
  });

  describe('webhook-no-retry', () => {
    const delivered = async () => (pick((await listDeliveries(h)).body, 'items') as Record<string, unknown>[])[0];

    it('без сбоя после ответа с ошибкой отправка повторяется', async () => {
      await putWebhook(h, URL, 'secret-1');
      await payOrder(h, { orderId: 'order-hook-off', amount: 10_000 });
      h.webhook.answers({ kind: 'RESPONSE', status: 500 });
      await h.dispatchWebhooks(T0);
      assert.equal((await delivered())?.status, 'PENDING');
      const facts = (await h.kit('GET', '/_kit/facts/webhook-deliveries')).body as { defects: unknown[] }[];
      assert.deepEqual(facts.map((item) => item.defects), [[]]);
    });

    it('со сбоем после ответа 500 одна попытка и итог FAILED, повторов нет; пометка лежит на доставке и видна в служебных фактах, но не в партнёрском журнале', async () => {
      await setDefects(h, ['webhook-no-retry']);
      await putWebhook(h, URL, 'secret-1');
      const paid = await payOrder(h, { orderId: 'order-hook-on', amount: 10_000 });
      h.webhook.answers({ kind: 'RESPONSE', status: 500 });
      assert.equal(await h.dispatchWebhooks(T0), 1);
      const item = await delivered();
      assert.equal(item?.status, 'FAILED');
      assert.equal(item?.attemptsMade, 1);
      assert.equal(item?.nextAttemptAt, null);
      assert.equal('defects' in (item as object), false);
      assert.equal(await h.dispatchWebhooks(new Date(T0.getTime() + 1_000_000)), 0);
      assert.equal(h.webhook.requests.length, 1);
      const facts = (await h.kit('GET', `/_kit/facts/webhook-deliveries?qrId=${paid.qrId}`)).body as { defects: { code: string; details: Record<string, unknown> }[] }[];
      assert.deepEqual(facts[0]?.defects, [
        { code: 'webhook-no-retry', details: { expected: 'RETRY', actual: 'FAILED', attempt: 1, statusCode: 500, error: null, retryExpectedInSec: 10 } },
      ]);
    });

    it('со сбоем тайм-аут тоже не повторяется; успешная доставка идёт без пометки', async () => {
      await setDefects(h, ['webhook-no-retry']);
      await putWebhook(h, URL, 'secret-1');
      await payOrder(h, { orderId: 'order-hook-timeout', amount: 10_000 });
      await payOrder(h, { orderId: 'order-hook-fine', amount: 10_000 });
      h.webhook.answers({ kind: 'ERROR', error: 'TIMEOUT' }, { kind: 'RESPONSE', status: 204 });
      await h.dispatchWebhooks(T0);
      const facts = (await h.kit('GET', '/_kit/facts/webhook-deliveries')).body as { status: string; attempts: { error: string | null }[]; defects: { details: Record<string, unknown> }[] }[];
      assert.deepEqual(facts.map((item) => item.status).sort(), ['DELIVERED', 'FAILED']);
      const failed = facts.find((item) => item.status === 'FAILED');
      const delivered = facts.find((item) => item.status === 'DELIVERED');
      assert.equal(failed?.defects[0]?.details.error, 'TIMEOUT');
      assert.deepEqual(delivered?.defects, []);
    });

    it('доставка связана с задачей через метку попытки QR-кода', async () => {
      assert.equal((await h.kit('POST', '/_kit/scenario', { ...BASE, defects: ['webhook-no-retry'] })).status, 200);
      await putWebhook(h, URL, 'secret-1');
      await payOrder(h, { orderId: 'order-hook-label', amount: 10_000 });
      h.webhook.answers({ kind: 'RESPONSE', status: 500 });
      await h.dispatchWebhooks(T0);
      const mine = (await h.kit('GET', '/_kit/facts/webhook-deliveries?label=defects%3Arun-1')).body as unknown[];
      const other = (await h.kit('GET', '/_kit/facts/webhook-deliveries?label=defects%3Aother')).body as unknown[];
      assert.equal(mine.length, 1);
      assert.equal(other.length, 0);
    });
  });

  describe('включение и выключение', () => {
    it('сценарий принимает коды четырёх дефектов, сценарий без них и сброс выключают', async () => {
      const all = ['qr-double-payment', 'qr-expired-accepted', 'refund-over-amount', 'webhook-no-retry'];
      assert.equal((await h.kit('POST', '/_kit/scenario', { ...BASE, defects: all })).status, 200);
      assert.deepEqual([...(await loadActiveDefects(h.pool))].sort(), all);
      assert.equal((await h.kit('POST', '/_kit/scenario', { ...BASE, defects: [] })).status, 200);
      assert.equal((await loadActiveDefects(h.pool)).size, 0);
      assert.equal((await h.kit('POST', '/_kit/scenario', { ...BASE, defects: all })).status, 200);
      assert.equal((await h.kit('POST', '/_kit/reset')).status, 200);
      assert.equal((await loadActiveDefects(h.pool)).size, 0);
    });

    it('сброс стирает пометки доставок вместе с доставками', async () => {
      await setDefects(h, ['webhook-no-retry']);
      await putWebhook(h, URL, 'secret-1');
      await payOrder(h, { orderId: 'order-hook-reset-marks', amount: 10_000 });
      h.webhook.answers({ kind: 'RESPONSE', status: 500 });
      await h.dispatchWebhooks(T0);
      assert.equal((await h.pool.query('SELECT 1 FROM webhook_delivery_marks')).rowCount, 1);
      await h.kit('POST', '/_kit/reset');
      assert.equal((await h.pool.query('SELECT 1 FROM webhook_delivery_marks')).rowCount, 0);
    });
  });
});
