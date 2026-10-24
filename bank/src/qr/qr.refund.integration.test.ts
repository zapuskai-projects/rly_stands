import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { formatRubles } from '../accounts/money';
import { pick, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { balanceOfClient, incomeBalance, issuedQr, partnerApi, payOrder, readQr, refundQr, SHOP_CLIENT_NUMBER, startOnRelease } from '../testing/qr';
import { accountOf, PHONES } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const SOME_ID = '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

describe('возвраты по QR на релизе 1.2', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startOnRelease('1.2');
  });

  afterEach(async () => {
    await h.close();
  });

  const refundedOf = async (qrId: string) => ({
    status: pick((await readQr(h, qrId)).body, 'status'),
    refunded: pick((await readQr(h, qrId)).body, 'refundedAmount'),
  });

  it('полный возврат: деньги возвращаются покупателю, комиссия магазину не возвращается, книга сходится', async () => {
    const shopStart = await balanceOfClient(h, SHOP_CLIENT_NUMBER);
    const incomeStart = await incomeBalance(h);
    const paid = await payOrder(h, { orderId: 'order-full', amount: 123_450, description: 'Заказ №1' });
    const annaPaid = (await accountOf(h, paid.token)).balance;
    const refund = await refundQr(h, paid.qrId, 123_450, 'refund-full-0001');
    assert.equal(refund.status, 201);
    assert.equal(pick(refund.body, 'amount'), 123_450);
    assert.equal(pick(refund.body, 'refundedAmount'), 123_450);
    assert.equal(pick(refund.body, 'qrStatus'), 'REFUNDED');
    assert.equal(pick(refund.body, 'qrId'), paid.qrId);
    assert.match(String(pick(refund.body, 'operationNumber')), /^ZB\d{10}$/);

    const state = await readQr(h, paid.qrId);
    assert.equal(pick(state.body, 'status'), 'REFUNDED');
    assert.equal(pick(state.body, 'paidAmount'), 123_450);
    assert.equal(pick(state.body, 'refundedAmount'), 123_450);
    assert.equal(pick(state.body, 'operationId'), paid.operationId);

    assert.equal((await accountOf(h, paid.token)).balance, annaPaid + 123_450);
    assert.equal((await balanceOfClient(h, SHOP_CLIENT_NUMBER)).balance - shopStart.balance, -864n);
    assert.equal((await incomeBalance(h)) - incomeStart, 864n);
    const report = await checkLedger(h.pool);
    assert.deepEqual(report.mismatchedAccounts, []);
    assert.equal(report.totalOfBalances, 0n);
    assert.deepEqual((await h.kit('GET', '/_kit/facts/ledger')).body, { inconsistent: [] });

    const operation = await h.pool.query<{ type: string; status: string; amount_kop: bigint; fee_kop: bigint; qr_id: string }>(
      "SELECT type, status, amount_kop, fee_kop, qr_id FROM operations WHERE id = $1",
      [String(pick(refund.body, 'operationId'))],
    );
    assert.deepEqual(operation.rows, [{ type: 'QR_REFUND', status: 'COMPLETED', amount_kop: 123_450n, fee_kop: 0n, qr_id: paid.qrId }]);
    const postings = await h.pool.query<{ kind: string; description: string; debit: string; credit: string }>(
      `SELECT p.kind, p.description, da.kind AS debit, ca.kind AS credit FROM postings p
       JOIN accounts da ON da.id = p.debit_account_id JOIN accounts ca ON ca.id = p.credit_account_id WHERE p.operation_id = $1`,
      [String(pick(refund.body, 'operationId'))],
    );
    assert.deepEqual(postings.rows.map((row) => [row.kind, row.debit, row.credit]), [['REFUND', 'SETTLEMENT', 'CURRENT']]);
    assert.match(postings.rows[0]?.description ?? '', /Возврат оплаты по QR из «Лавка Гарипова»/);
  });

  it('покупатель получает СМС и пуш о возврате, событие создания операции возврата уходит в Kafka', async () => {
    const paid = await payOrder(h, { orderId: 'order-notify', amount: 50_000 });
    const refund = await refundQr(h, paid.qrId, 20_000, 'refund-notify-001');
    await h.drain();
    const texts = await h.pool.query<{ channel: string; text: string }>(
      "SELECT channel, text FROM notifications WHERE phone = $1 AND kind = 'TRANSFER_RECEIVED' ORDER BY id",
      [PHONES.ANNA],
    );
    const amount = formatRubles(20_000n);
    assert.deepEqual(texts.rows.map((row) => row.channel), ['SMS', 'PUSH']);
    assert.equal(texts.rows[0]?.text, `ЗапускБанк: возврат по QR ${amount} от «Лавка Гарипова». Операция ${String(pick(refund.body, 'operationNumber'))}.`);
    const event = h.events.map((item) => item.payload as Record<string, unknown>).find((item) => item.operationId === pick(refund.body, 'operationId') && item.type);
    assert.ok(event);
    assert.equal(event.type, 'QR_REFUND');
    assert.equal(event.route, 'INTERNAL');
    assert.equal(event.amount, 20_000);
    assert.equal(event.fee, 0);
    assert.equal(event.qrId, paid.qrId);
    assert.equal(event.clientNumber, SHOP_CLIENT_NUMBER);
    assert.equal(event.recipientPhone, null);
  });

  it('частичные возвраты: статус меняется, остаток к возврату уменьшается, лишнее отвергается, последний возврат закрывает QR', async () => {
    const paid = await payOrder(h, { orderId: 'order-part', amount: 100_000 });
    const first = await refundQr(h, paid.qrId, 30_000, 'refund-part-0001');
    assert.equal(pick(first.body, 'qrStatus'), 'PARTIALLY_REFUNDED');
    assert.deepEqual(await refundedOf(paid.qrId), { status: 'PARTIALLY_REFUNDED', refunded: 30_000 });
    const second = await refundQr(h, paid.qrId, 50_000, 'refund-part-0002');
    assert.equal(pick(second.body, 'refundedAmount'), 80_000);
    assert.equal(pick(second.body, 'amount'), 50_000);

    const operationsBefore = (await h.pool.query("SELECT 1 FROM operations WHERE type = 'QR_REFUND'")).rowCount;
    const over = await refundQr(h, paid.qrId, 20_001, 'refund-part-0003');
    assert.equal(over.status, 422);
    assert.equal(pick(over.body, 'code'), 'REFUND_EXCEEDS_PAYMENT');
    assert.ok(String(pick(over.body, 'message')).includes(formatRubles(20_000n)));
    assert.equal((await h.pool.query("SELECT 1 FROM operations WHERE type = 'QR_REFUND'")).rowCount, operationsBefore);
    assert.deepEqual(await refundedOf(paid.qrId), { status: 'PARTIALLY_REFUNDED', refunded: 80_000 });

    const last = await refundQr(h, paid.qrId, 20_000, 'refund-part-0004');
    assert.equal(pick(last.body, 'qrStatus'), 'REFUNDED');
    const more = await refundQr(h, paid.qrId, 1, 'refund-part-0005');
    assert.equal(more.status, 422);
    assert.equal(pick(more.body, 'code'), 'REFUND_EXCEEDS_PAYMENT');
    assert.deepEqual(await refundedOf(paid.qrId), { status: 'REFUNDED', refunded: 100_000 });
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('сумма возвратов никогда не больше оплаты: одновременные возвраты не обгоняют друг друга', async () => {
    const paid = await payOrder(h, { orderId: 'order-race-refund', amount: 100_000 });
    const answers = await Promise.all([1, 2, 3, 4].map((index) => refundQr(h, paid.qrId, 40_000, `refund-race-000${index}`)));
    assert.deepEqual(answers.map((item) => item.status).sort(), [201, 201, 422, 422]);
    assert.deepEqual(await refundedOf(paid.qrId), { status: 'PARTIALLY_REFUNDED', refunded: 80_000 });
  });

  it('повтор запроса с тем же ключом и суммой возвращает тот же возврат, другая сумма — отказ, ключ обязателен', async () => {
    const paid = await payOrder(h, { orderId: 'order-idem-refund', amount: 100_000 });
    const first = await refundQr(h, paid.qrId, 30_000, 'refund-idem-0001');
    const replay = await refundQr(h, paid.qrId, 30_000, 'refund-idem-0001');
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(pick(replay.body, 'refundId'), pick(first.body, 'refundId'));
    assert.equal(pick(replay.body, 'operationId'), pick(first.body, 'operationId'));
    assert.equal((await h.pool.query("SELECT 1 FROM operations WHERE type = 'QR_REFUND'")).rowCount, 1);
    const reused = await refundQr(h, paid.qrId, 31_000, 'refund-idem-0001');
    assert.equal(reused.status, 422);
    assert.equal(pick(reused.body, 'code'), 'IDEMPOTENCY_KEY_REUSED');
    assert.equal((await refundedOf(paid.qrId)).refunded, 30_000);

    const withoutKey = await partnerApi(h, 'POST', `/partner/v1/qr/${paid.qrId}/refunds`, { amount: 100 });
    assert.equal(withoutKey.status, 400);
    const shortKey = await refundQr(h, paid.qrId, 100, 'short');
    assert.equal(shortKey.status, 400);
  });

  it('вернуть можно только оплаченный QR; нет такого QR — 404; неверная сумма — 400', async () => {
    const open = await issuedQr(h, { orderId: 'order-unpaid', amount: 10_000 });
    const unpaid = await refundQr(h, open.qrId, 100, 'refund-unpaid-001');
    assert.equal(unpaid.status, 409);
    assert.equal(pick(unpaid.body, 'code'), 'QR_NOT_PAID');
    await partnerApi(h, 'DELETE', `/partner/v1/qr/${open.qrId}`);
    assert.equal((await refundQr(h, open.qrId, 100, 'refund-unpaid-002')).status, 409);
    const missing = await refundQr(h, SOME_ID, 100, 'refund-missing-01');
    assert.equal(missing.status, 404);
    assert.equal(pick(missing.body, 'code'), 'QR_NOT_FOUND');
    const paid = await payOrder(h, { orderId: 'order-bad-amount', amount: 10_000 });
    for (const amount of [0, -5, 1.5, 100_000_001]) {
      assert.equal((await refundQr(h, paid.qrId, amount, `refund-bad-${Math.abs(amount)}-key`)).status, 400, String(amount));
    }
    assert.equal((await partnerApi(h, 'POST', `/partner/v1/qr/${paid.qrId}/refunds`, { amount: 1, extra: 1 }, { 'X-Partner-Key': 'zbk_wrong', 'Idempotency-Key': 'refund-401-key-1' })).status, 401);
  });

  it('если на расчётном счёте магазина не хватает денег, возврат отказывает и ничего не создаёт', async () => {
    const paid = await payOrder(h, { orderId: 'order-poor-shop', amount: 50_000 });
    await h.pool.query("UPDATE accounts SET balance_kop = 1000 WHERE kind = 'SETTLEMENT'");
    const refund = await refundQr(h, paid.qrId, 30_000, 'refund-poor-0001');
    assert.equal(refund.status, 422);
    assert.equal(pick(refund.body, 'code'), 'INSUFFICIENT_FUNDS');
    assert.equal((await h.pool.query("SELECT 1 FROM operations WHERE type = 'QR_REFUND'")).rowCount, 0);
    assert.equal(pick((await readQr(h, paid.qrId)).body, 'status'), 'PAID');
  });

  it('операции возвратов видны владельцу магазина и в офисе, а при возврате на 1.0 исчезают', async () => {
    const paid = await payOrder(h, { orderId: 'order-visible-refund', amount: 50_000 });
    const refund = await refundQr(h, paid.qrId, 10_000, 'refund-visible-01');
    const shop = await h.login(PHONES.IP);
    const list = await h.api(shop, 'GET', '/api/v1/operations?type=QR_REFUND');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const items = pick(list.body, 'items') as { id: string; type: string; recipient: { displayName: string }; qrId: string; total: number }[];
    assert.deepEqual(items.map((item) => [item.id, item.type, item.recipient.displayName, item.qrId, item.total]), [[pick(refund.body, 'operationId'), 'QR_REFUND', 'Анна С.', paid.qrId, 10_000]]);
    const operator = await h.operatorLogin();
    assert.equal(((await h.api(operator, 'GET', '/api/v1/office/operations?type=QR_REFUND')).body as { total: number }).total, 1);
    const facts = (await h.kit('GET', '/_kit/facts/operations')).body as { type: string }[];
    assert.ok(facts.some((item) => item.type === 'QR_REFUND'));
    await h.pool.query("UPDATE scenario SET release = '1.0' WHERE id = 1");
    assert.deepEqual(pick((await h.api(shop, 'GET', '/api/v1/operations?limit=100')).body, 'items'), []);
  });
});
