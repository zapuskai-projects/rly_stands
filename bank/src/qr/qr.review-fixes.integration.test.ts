import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, type Harness } from '../testing/harness';
import { issuedQr, payOrder, payQr, readQr, refundQr, startOnRelease } from '../testing/qr';
import { accountOf, PHONES, phoneTransfer, sendTransfer, useRelease } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const SHOP_NUMBER = '10000004';

describe('правки после ревью: возвраты, оплата магазину, релизы', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startOnRelease('1.2');
  });

  afterEach(async () => {
    await h.close();
  });

  const operationsCount = async (type: string) => (await h.pool.query('SELECT 1 FROM operations WHERE type = $1', [type])).rowCount;

  describe('возврат и состояние магазина', () => {
    it('арест расчётного счёта магазина отклоняет возврат кодом ACCOUNT_ARRESTED, после снятия ареста возврат проходит', async () => {
      const paid = await payOrder(h, { orderId: 'order-arrest-refund', amount: 50_000 });
      await h.pool.query("UPDATE accounts SET status = 'ARRESTED' WHERE kind = 'SETTLEMENT'");
      const refused = await refundQr(h, paid.qrId, 10_000, 'arrest-refund-001');
      assert.equal(refused.status, 422);
      assert.equal(pick(refused.body, 'code'), 'ACCOUNT_ARRESTED');
      assert.equal(pick(refused.body, 'message'), 'По счёту наложен арест, расходные операции приостановлены');
      assert.equal(await operationsCount('QR_REFUND'), 0);
      assert.equal(pick((await readQr(h, paid.qrId)).body, 'refundedAmount'), 0);
      await h.pool.query("UPDATE accounts SET status = 'ACTIVE' WHERE kind = 'SETTLEMENT'");
      assert.equal((await refundQr(h, paid.qrId, 10_000, 'arrest-refund-001')).status, 201);
    });

    it('заблокированный магазин не делает возвраты: 422 CLIENT_BLOCKED', async () => {
      const paid = await payOrder(h, { orderId: 'order-blocked-refund', amount: 50_000 });
      await h.pool.query("UPDATE clients SET status = 'BLOCKED' WHERE number = $1", [SHOP_NUMBER]);
      const refused = await refundQr(h, paid.qrId, 10_000, 'blocked-refund-01');
      assert.equal(refused.status, 422);
      assert.equal(pick(refused.body, 'code'), 'CLIENT_BLOCKED');
      assert.equal(await operationsCount('QR_REFUND'), 0);
      await h.pool.query("UPDATE clients SET status = 'ACTIVE' WHERE number = $1", [SHOP_NUMBER]);
      assert.equal((await refundQr(h, paid.qrId, 10_000, 'blocked-refund-02')).status, 201);
    });

    it('замороженные деньги магазина учитываются: возврат не проходит, пока доступно меньше суммы', async () => {
      const paid = await payOrder(h, { orderId: 'order-held-refund', amount: 50_000 });
      await h.pool.query("UPDATE accounts SET balance_kop = 70000 WHERE kind = 'SETTLEMENT'");
      await h.pool.query("INSERT INTO holds (account_id, operation_id, amount_kop, created_at) SELECT id, $1, 40000, now() FROM accounts WHERE kind = 'SETTLEMENT'", [paid.operationId]);
      const refused = await refundQr(h, paid.qrId, 50_000, 'held-refund-0001');
      assert.equal(pick(refused.body, 'code'), 'INSUFFICIENT_FUNDS');
      await h.pool.query("UPDATE holds SET status = 'RELEASED' WHERE amount_kop = 40000");
      assert.equal((await refundQr(h, paid.qrId, 50_000, 'held-refund-0002')).status, 201);
    });

    it('заморозка, появившаяся, пока возврат ждёт блокировки счёта, учитывается: замороженное читается после блокировки', async () => {
      const paid = await payOrder(h, { orderId: 'order-lock-order', amount: 50_000 });
      await h.pool.query("UPDATE accounts SET balance_kop = 70000 WHERE kind = 'SETTLEMENT'");
      const holder = await h.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query("SELECT id FROM accounts WHERE kind = 'SETTLEMENT' FOR UPDATE");
        const pending = refundQr(h, paid.qrId, 50_000, 'lock-order-00001');
        await new Promise((resolve) => setTimeout(resolve, 400));
        await holder.query("INSERT INTO holds (account_id, operation_id, amount_kop, created_at) SELECT id, $1, 40000, now() FROM accounts WHERE kind = 'SETTLEMENT'", [paid.operationId]);
        await holder.query('COMMIT');
        const answer = await pending;
        assert.equal(answer.status, 422);
        assert.equal(pick(answer.body, 'code'), 'INSUFFICIENT_FUNDS');
      } finally {
        holder.release();
      }
    });

    it('два возврата по разным QR одновременно не уводят счёт магазина в минус: проходит один', async () => {
      const first = await payOrder(h, { orderId: 'order-race-funds-1', amount: 50_000 });
      const second = await payOrder(h, { orderId: 'order-race-funds-2', amount: 50_000 });
      await h.pool.query("UPDATE accounts SET balance_kop = 70000 WHERE kind = 'SETTLEMENT'");
      const answers = await Promise.all([refundQr(h, first.qrId, 50_000, 'race-funds-00001'), refundQr(h, second.qrId, 50_000, 'race-funds-00002')]);
      assert.deepEqual(answers.map((item) => item.status).sort(), [201, 422]);
      assert.equal((await h.pool.query<{ balance_kop: bigint }>("SELECT balance_kop FROM accounts WHERE kind = 'SETTLEMENT'")).rows[0]?.balance_kop, 20_000n);
    });
  });

  describe('оплата магазину, который не может принимать платежи', () => {
    it('клиент магазина не активен: 422 RECIPIENT_NOT_FOUND, операции нет, QR остаётся ждать оплаты', async () => {
      const qr = await issuedQr(h, { orderId: 'order-shop-blocked', amount: 10_000 });
      const anna = await h.login(ANNA);
      const account = await accountOf(h, anna);
      await h.pool.query("UPDATE clients SET status = 'BLOCKED' WHERE number = $1", [SHOP_NUMBER]);
      const refused = await payQr(h, anna, 'shop-blocked-0001', qr.payload, account.id);
      assert.equal(refused.status, 422);
      assert.equal(pick(refused.body, 'code'), 'RECIPIENT_NOT_FOUND');
      assert.equal(pick(refused.body, 'message'), 'Магазин не принимает платежи');
      assert.equal(await operationsCount('QR_PAYMENT'), 0);
      assert.equal((await accountOf(h, anna)).held, 0);
      assert.equal(pick((await readQr(h, qr.qrId)).body, 'status'), 'CREATED');
      await h.pool.query("UPDATE clients SET status = 'ACTIVE' WHERE number = $1", [SHOP_NUMBER]);
      assert.equal((await payQr(h, anna, 'shop-blocked-0002', qr.payload, account.id)).status, 201);
    });

    it('расчётный счёт магазина закрыт: тот же отказ; арестованный счёт деньги принимает', async () => {
      const qr = await issuedQr(h, { orderId: 'order-shop-closed', amount: 10_000 });
      const anna = await h.login(ANNA);
      const account = await accountOf(h, anna);
      await h.pool.query("UPDATE accounts SET status = 'CLOSED' WHERE kind = 'SETTLEMENT'");
      const refused = await payQr(h, anna, 'shop-closed-0001', qr.payload, account.id);
      assert.equal(pick(refused.body, 'code'), 'RECIPIENT_NOT_FOUND');
      assert.equal(await operationsCount('QR_PAYMENT'), 0);
      await h.pool.query("UPDATE accounts SET status = 'ARRESTED' WHERE kind = 'SETTLEMENT'");
      assert.equal((await payQr(h, anna, 'shop-closed-0002', qr.payload, account.id)).status, 201);
    });
  });

  describe('значения видов операций следующих релизов', () => {
    const typeQuery = (token: string, path: string, type: string) => h.api(token, 'GET', `${path}?type=${type}`);

    for (const release of ['1.0', '1.1'] as const) {
      it(`релиз ${release}: type=QR_PAYMENT и QR_REFUND в фильтрах клиента и офиса — 400 как неизвестное значение`, async () => {
        await useRelease(h, release);
        const anna = await h.login(ANNA);
        const operator = await h.operatorLogin();
        for (const [token, path] of [[anna, '/api/v1/operations'], [operator, '/api/v1/office/operations']] as const) {
          for (const type of ['QR_PAYMENT', 'QR_REFUND']) {
            const response = await typeQuery(token, path, type);
            assert.equal(response.status, 400, `${path} ${type}`);
            assert.equal(pick(response.body, 'code'), 'VALIDATION_ERROR');
            const detail = (pick(response.body, 'details') as { field: string; message: string }[])[0];
            assert.equal(detail?.field, 'query.type');
            assert.equal(detail?.message, 'Неверный вариант: ожидалось одно из "OWN_TRANSFER"|"PHONE_TRANSFER"');
          }
          assert.equal((await typeQuery(token, path, 'PHONE_TRANSFER')).status, 200);
          assert.equal((await typeQuery(token, path, 'OWN_TRANSFER')).status, 200);
          assert.equal((await typeQuery(token, path, 'NOPE')).status, 400);
        }
      });
    }

    it('релиз 1.2: те же значения принимаются', async () => {
      const anna = await h.login(ANNA);
      const operator = await h.operatorLogin();
      for (const [token, path] of [[anna, '/api/v1/operations'], [operator, '/api/v1/office/operations']] as const) {
        for (const type of ['QR_PAYMENT', 'QR_REFUND']) assert.equal((await typeQuery(token, path, type)).status, 200, `${path} ${type}`);
      }
    });
  });

  describe('QR-операции ниже релиза 1.2 в чужих выборках', () => {
    it('недавние операции клиента в карточке ручной проверки скрыты ниже 1.2 и видны на 1.2', async () => {
      await payOrder(h, { orderId: 'order-recent', amount: 10_000 });
      await h.pool.query('UPDATE antifraud_settings SET review_threshold = 1, reject_threshold = 100');
      const anna = await h.login(ANNA);
      const account = await accountOf(h, anna);
      const transfer = await sendTransfer(h, anna, 'recent-review-0001', phoneTransfer(account.number, PETR, 100_000));
      await h.drain();
      const operator = await h.operatorLogin();
      const path = `/api/v1/office/reviews/${String(pick(transfer.body, 'id'))}`;
      const types = async () => ((pick((await h.api(operator, 'GET', path)).body, 'recentOperations') as { type: string }[]) ?? []).map((item) => item.type);
      assert.ok((await types()).includes('QR_PAYMENT'));
      await useRelease(h, '1.1');
      assert.equal((await types()).includes('QR_PAYMENT'), false);
    });

    it('выписка скрывает QR-операции ниже 1.2: суммы и остатки те же, описание нейтральное, ссылки на операцию нет', async () => {
      const paid = await payOrder(h, { orderId: 'order-statement', amount: 123_450 });
      const statement = async () => (await h.api(paid.token, 'GET', `/api/v1/accounts/${paid.accountId}/statement`)).body as {
        openingBalance: number;
        closingBalance: number;
        totalDebit: number;
        entries: { amount: number; description: string; operationId: string | null; balanceAfter: number }[];
      };
      const open = await statement();
      const entry = open.entries.find((item) => item.operationId === paid.operationId);
      assert.match(entry?.description ?? '', /Оплата по QR/);
      await useRelease(h, '1.0');
      const hidden = await statement();
      assert.deepEqual(hidden.entries.map((item) => [item.amount, item.balanceAfter]), open.entries.map((item) => [item.amount, item.balanceAfter]));
      assert.equal(hidden.closingBalance, open.closingBalance);
      assert.equal(hidden.totalDebit, open.totalDebit);
      assert.equal(JSON.stringify(hidden).includes('QR'), false);
      assert.equal(hidden.entries.some((item) => item.operationId === paid.operationId), false);
      assert.ok(hidden.entries.some((item) => item.description === 'Платёж' && item.operationId === null));
    });
  });
});
