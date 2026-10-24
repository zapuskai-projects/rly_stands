import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { formatRubles } from '../accounts/money';
import { loadAsyncApi } from '../testing/asyncapi';
import { checkLedger } from '../testing/ledger-check';
import { pick, type Harness } from '../testing/harness';
import { balanceOfClient, incomeBalance, issuedQr, payQr, readQr, partnerApi, startOnRelease, SHOP_CLIENT_NUMBER } from '../testing/qr';
import { accountOf, NIGHT_MOSCOW, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer } from '../testing/scenarios';
import { expireQrCodes } from './qr-sweep';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const SOME_ID = '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';

describe('оплата по QR на релизе 1.2', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startOnRelease('1.2');
  });

  afterEach(async () => {
    await h.close();
  });

  const settings = (review: number, reject: number) => h.pool.query('UPDATE antifraud_settings SET review_threshold = $1, reject_threshold = $2 WHERE id = 1', [review, reject]);

  it('клиент оплачивает QR: статус PAID, остатки и комиссия сходятся, книга учёта без расхождений', async () => {
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const shopBefore = await balanceOfClient(h, SHOP_CLIENT_NUMBER);
    const incomeBefore = await incomeBalance(h);
    const qr = await issuedQr(h, { orderId: 'order-pay', amount: 123_450, description: 'Заказ №2026-0001' });

    const lookup = await h.api(anna, 'GET', `/api/v1/qr-payments/lookup?payload=${encodeURIComponent(qr.payload)}`);
    assert.equal(lookup.status, 200);
    assert.equal(pick(lookup.body, 'merchant'), 'Лавка Гарипова');
    assert.equal(pick(lookup.body, 'amount'), 123_450);
    assert.equal(pick(lookup.body, 'description'), 'Заказ №2026-0001');
    assert.equal(pick(lookup.body, 'status'), 'CREATED');

    const paid = await payQr(h, anna, 'pay-main-0001', qr.payload, account.id);
    assert.equal(paid.status, 201);
    assert.equal(pick(paid.body, 'type'), 'QR_PAYMENT');
    assert.equal(pick(paid.body, 'status'), 'CHECKING');
    assert.equal(pick(paid.body, 'fee'), 0);
    assert.equal(pick(paid.body, 'total'), 123_450);
    assert.equal(pick(paid.body, 'qrId'), qr.qrId);
    assert.equal(pick(paid.body, 'recipient.displayName'), 'Лавка Гарипова');
    assert.equal(pick(paid.body, 'recipient.phone'), null);
    assert.equal(pick(paid.body, 'comment'), 'Заказ №2026-0001');
    const held = await h.api(anna, 'GET', '/api/v1/accounts');
    assert.equal(pick(held.body, 'items.0.held'), 123_450);
    assert.equal(pick(held.body, 'items.0.balance'), account.balance);

    await h.drain();
    const operationId = String(pick(paid.body, 'id'));
    const operation = await h.api(anna, 'GET', `/api/v1/operations/${operationId}`);
    assert.equal(pick(operation.body, 'status'), 'COMPLETED');
    assert.deepEqual((pick(operation.body, 'statusHistory') as { status: string }[]).map((item) => item.status), ['CREATED', 'CHECKING', 'PROCESSING', 'COMPLETED']);

    const state = await readQr(h, qr.qrId);
    assert.equal(pick(state.body, 'status'), 'PAID');
    assert.equal(pick(state.body, 'paidAmount'), 123_450);
    assert.equal(pick(state.body, 'refundedAmount'), 0);
    assert.equal(pick(state.body, 'operationId'), operationId);
    assert.equal(pick(state.body, 'operationNumber'), pick(operation.body, 'number'));
    assert.equal(pick(state.body, 'paidAt'), pick(operation.body, 'completedAt'));

    const commission = 864n;
    assert.equal((await accountOf(h, anna)).balance, account.balance - 123_450);
    assert.equal((await balanceOfClient(h, SHOP_CLIENT_NUMBER)).balance - shopBefore.balance, 123_450n - commission);
    assert.equal((await incomeBalance(h)) - incomeBefore, commission);
    const report = await checkLedger(h.pool);
    assert.deepEqual(report.mismatchedAccounts, []);
    assert.equal(report.totalOfBalances, 0n);
    assert.deepEqual((await h.kit('GET', '/_kit/facts/ledger')).body, { inconsistent: [] });

    const postings = await h.pool.query<{ kind: string; amount_kop: bigint; description: string }>(
      'SELECT kind, amount_kop, description FROM postings WHERE operation_id = $1 ORDER BY id',
      [operationId],
    );
    assert.deepEqual(postings.rows.map((row) => [row.kind, row.amount_kop]), [['TRANSFER', 123_450n], ['FEE', commission]]);
    const sms = await h.pool.query<{ text: string }>("SELECT text FROM notifications WHERE phone = $1 AND kind = 'TRANSFER_COMPLETED' ORDER BY id", [ANNA]);
    assert.ok((sms.rows[0]?.text ?? '').includes(`оплата по QR ${formatRubles(123_450n)} в «Лавка Гарипова» выполнена`));
  });

  it('комиссия 0,7 % округляется до копейки по правилам половины вверх', async () => {
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    for (const [amount, commission] of [[143, 1n], [71, 0n], [72, 1n], [100_000, 700n]] as const) {
      const incomeBefore = await incomeBalance(h);
      const qr = await issuedQr(h, { orderId: `order-round-${amount}`, amount });
      const paid = await payQr(h, anna, `pay-round-${amount}-001`, qr.payload, account.id);
      assert.equal(paid.status, 201);
      await h.drain();
      assert.equal((await incomeBalance(h)) - incomeBefore, commission, String(amount));
    }
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('повторная оплата того же QR отказывает, неизвестный, просроченный и отменённый тоже', async () => {
    const anna = await h.login(ANNA);
    const petr = await h.login(PETR);
    const account = await accountOf(h, anna);
    const petrAccount = await accountOf(h, petr);
    const qr = await issuedQr(h, { orderId: 'order-once', amount: 10_000 });
    assert.equal((await payQr(h, anna, 'pay-once-0001', qr.payload, account.id)).status, 201);
    await h.drain();

    const second = await payQr(h, petr, 'pay-once-0002', qr.payload, petrAccount.id);
    assert.equal(second.status, 409);
    assert.equal(pick(second.body, 'code'), 'QR_ALREADY_PAID');
    assert.equal((await accountOf(h, petr)).balance, petrAccount.balance);

    const missing = await payQr(h, anna, 'pay-miss-0001', `zbqr://pay?id=${SOME_ID}`, account.id);
    assert.equal(missing.status, 404);
    assert.equal(pick(missing.body, 'code'), 'QR_NOT_FOUND');
    const lookupMissing = await h.api(anna, 'GET', `/api/v1/qr-payments/lookup?payload=${encodeURIComponent(`zbqr://pay?id=${SOME_ID}`)}`);
    assert.equal(lookupMissing.status, 404);

    const garbage = await payQr(h, anna, 'pay-bad-0001', 'https://example.com', account.id);
    assert.equal(garbage.status, 400);
    assert.ok((pick(garbage.body, 'details') as { field: string }[]).some((item) => item.field === 'body.payload'));

    const cancelled = await issuedQr(h, { orderId: 'order-cancel', amount: 10_000 });
    const cancel = await partnerApi(h, 'DELETE', `/partner/v1/qr/${cancelled.qrId}`);
    assert.equal(cancel.status, 200);
    assert.equal(pick(cancel.body, 'status'), 'CANCELLED');
    const afterCancel = await payQr(h, anna, 'pay-cancel-0001', cancelled.payload, account.id);
    assert.equal(afterCancel.status, 409);
    assert.equal(pick(afterCancel.body, 'code'), 'QR_CANCELLED');

    const shortLived = await issuedQr(h, { orderId: 'order-short', amount: 10_000, ttlSeconds: 60 });
    h.setTime(new Date(NOON_MOSCOW.getTime() + 59_000));
    assert.equal(pick((await readQr(h, shortLived.qrId)).body, 'status'), 'CREATED');
    h.setTime(new Date(NOON_MOSCOW.getTime() + 60_000));
    assert.equal(pick((await readQr(h, shortLived.qrId)).body, 'status'), 'EXPIRED');
    const late = await payQr(h, anna, 'pay-late-0001', shortLived.payload, account.id);
    assert.equal(late.status, 409);
    assert.equal(pick(late.body, 'code'), 'QR_EXPIRED');
    const lookupLate = await h.api(anna, 'GET', `/api/v1/qr-payments/lookup?payload=${encodeURIComponent(shortLived.payload)}`);
    assert.equal(pick(lookupLate.body, 'status'), 'EXPIRED');
    assert.equal((await checkLedger(h.pool)).totalOfBalances, 0n);
  });

  it('просроченные QR переводятся в EXPIRED фоновой проверкой по часам банка', async () => {
    const qr = await issuedQr(h, { orderId: 'order-sweep', amount: 10_000, ttlSeconds: 60 });
    assert.equal(await expireQrCodes(h.deps), 0);
    h.setTime(new Date(NOON_MOSCOW.getTime() + 61_000));
    assert.equal(await expireQrCodes(h.deps), 1);
    const row = await h.pool.query<{ status: string }>('SELECT status FROM qr_codes WHERE id = $1', [qr.qrId]);
    assert.equal(row.rows[0]?.status, 'EXPIRED');
    const cancel = await partnerApi(h, 'DELETE', `/partner/v1/qr/${qr.qrId}`);
    assert.equal(cancel.status, 409);
    assert.equal(pick(cancel.body, 'code'), 'QR_EXPIRED');
  });

  it('пока оплата ждёт ручной проверки, вторая оплата и отмена отказывают; отклонение проверки освобождает QR', async () => {
    await settings(1, 100);
    const anna = await h.login(ANNA);
    const petr = await h.login(PETR);
    const operator = await h.operatorLogin();
    const account = await accountOf(h, anna);
    const petrAccount = await accountOf(h, petr);
    const qr = await issuedQr(h, { orderId: 'order-review', amount: 20_000, ttlSeconds: 60 });
    const first = await payQr(h, anna, 'pay-rev-0001', qr.payload, account.id);
    await h.drain();
    const operationId = String(pick(first.body, 'id'));
    assert.equal(pick((await h.api(anna, 'GET', `/api/v1/operations/${operationId}`)).body, 'status'), 'ON_REVIEW');
    assert.equal(pick((await readQr(h, qr.qrId)).body, 'status'), 'CREATED');

    const second = await payQr(h, petr, 'pay-rev-0002', qr.payload, petrAccount.id);
    assert.equal(second.status, 409);
    assert.equal(pick(second.body, 'code'), 'QR_ALREADY_PAID');
    assert.equal((await partnerApi(h, 'DELETE', `/partner/v1/qr/${qr.qrId}`)).status, 409);
    h.setTime(new Date(NOON_MOSCOW.getTime() + 61_000));
    assert.equal(pick((await readQr(h, qr.qrId)).body, 'status'), 'CREATED');
    assert.equal(await expireQrCodes(h.deps), 0);

    const rejected = await h.api(operator, 'POST', `/api/v1/office/reviews/${operationId}/reject`, { comment: 'Подозрительная оплата' });
    assert.equal(rejected.status, 200);
    await h.drain();
    assert.equal(pick((await h.api(anna, 'GET', `/api/v1/operations/${operationId}`)).body, 'status'), 'REJECTED');
    assert.equal((await accountOf(h, anna)).held, 0);
    assert.equal(pick((await readQr(h, qr.qrId)).body, 'status'), 'EXPIRED');
    assert.equal((await checkLedger(h.pool)).totalOfBalances, 0n);
  });

  it('одобренная проверка проводит платёж и QR становится PAID даже после срока', async () => {
    await settings(1, 100);
    const anna = await h.login(ANNA);
    const operator = await h.operatorLogin();
    const account = await accountOf(h, anna);
    const qr = await issuedQr(h, { orderId: 'order-approve', amount: 20_000, ttlSeconds: 60 });
    const first = await payQr(h, anna, 'pay-appr-0001', qr.payload, account.id);
    await h.drain();
    h.setTime(new Date(NOON_MOSCOW.getTime() + 600_000));
    const approved = await h.api(operator, 'POST', `/api/v1/office/reviews/${String(pick(first.body, 'id'))}/approve`, { comment: 'Подтвердил клиент' });
    assert.equal(approved.status, 200);
    await h.drain();
    assert.equal(pick((await readQr(h, qr.qrId)).body, 'status'), 'PAID');
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('антифрод оценивает оплату, но правило нового получателя не применяет; ночью срабатывает ночное правило', async () => {
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const qr = await issuedQr(h, { orderId: 'order-fraud', amount: 10_000 });
    const paid = await payQr(h, anna, 'pay-fraud-0001', qr.payload, account.id);
    await h.drain();
    const decision = await h.pool.query<{ score: number; rules: { code: string }[] }>('SELECT score, rules FROM antifraud_decisions WHERE operation_id = $1', [String(pick(paid.body, 'id'))]);
    assert.deepEqual(decision.rows[0]?.rules.map((rule) => rule.code), ['AMOUNT_ABOVE_USUAL']);
    assert.equal(decision.rows[0]?.score, 17);

    h.setTime(NIGHT_MOSCOW);
    const nightQr = await issuedQr(h, { orderId: 'order-night', amount: 10_000, ttlSeconds: 3600 });
    const night = await payQr(h, anna, 'pay-night-0001', nightQr.payload, account.id);
    await h.drain();
    const nightDecision = await h.pool.query<{ rules: { code: string }[] }>('SELECT rules FROM antifraud_decisions WHERE operation_id = $1', [String(pick(night.body, 'id'))]);
    assert.deepEqual(nightDecision.rows[0]?.rules.map((rule) => rule.code), ['NIGHT_TIME']);
  });

  it('оплата по QR не входит в суточный лимит переводов по телефону и не расходует его', async () => {
    const petr = await h.login(PETR);
    const account = await accountOf(h, petr);
    const before = await h.api(petr, 'GET', '/api/v1/me');
    const limit = Number(pick(before.body, 'limits.dailyPhoneTransfer.limit'));
    const toAnna = await sendTransfer(h, petr, 'qr-limit-phone-001', phoneTransfer(account.number, ANNA, limit - 1_000_00));
    assert.equal(toAnna.status, 201);
    await h.drain();
    const remaining = Number(pick((await h.api(petr, 'GET', '/api/v1/me')).body, 'limits.dailyPhoneTransfer.remaining'));
    const qr = await issuedQr(h, { orderId: 'order-limit', amount: 300_000 });
    const paid = await payQr(h, petr, 'pay-limit-0001', qr.payload, account.id);
    assert.equal(paid.status, 201);
    await h.drain();
    assert.equal(pick((await h.api(petr, 'GET', `/api/v1/operations/${String(pick(paid.body, 'id'))}`)).body, 'status'), 'COMPLETED');
    assert.equal(Number(pick((await h.api(petr, 'GET', '/api/v1/me')).body, 'limits.dailyPhoneTransfer.remaining')), remaining);
  });

  it('отказы по данным: чужой счёт, нехватка денег, счёт магазина; арест создаёт отклонённую операцию и QR остаётся', async () => {
    const anna = await h.login(ANNA);
    const petr = await h.login(PETR);
    const account = await accountOf(h, anna);
    const petrAccount = await accountOf(h, petr);
    const qr = await issuedQr(h, { orderId: 'order-data', amount: 50_000_000 });

    const foreign = await payQr(h, anna, 'pay-data-0001', qr.payload, petrAccount.id);
    assert.equal(foreign.status, 422);
    assert.equal(pick(foreign.body, 'code'), 'ACCOUNT_NOT_FOUND');
    const poor = await payQr(h, anna, 'pay-data-0002', qr.payload, account.id);
    assert.equal(poor.status, 422);
    assert.equal(pick(poor.body, 'code'), 'INSUFFICIENT_FUNDS');
    assert.equal(await h.pool.query('SELECT 1 FROM operations WHERE qr_id IS NOT NULL').then((result) => result.rowCount), 0);

    const shop = await h.login(PHONES.IP);
    const shopAccount = await accountOf(h, shop);
    const own = await payQr(h, shop, 'pay-data-0003', qr.payload, shopAccount.id);
    assert.equal(own.status, 422);
    assert.equal(pick(own.body, 'code'), 'SAME_ACCOUNT');

    const small = await issuedQr(h, { orderId: 'order-arrest', amount: 10_000 });
    await h.pool.query("UPDATE accounts SET status = 'ARRESTED' WHERE id = $1", [account.id]);
    const arrested = await payQr(h, anna, 'pay-data-0004', small.payload, account.id);
    assert.equal(arrested.status, 201);
    assert.equal(pick(arrested.body, 'status'), 'REJECTED');
    assert.equal(pick(arrested.body, 'rejection.code'), 'ACCOUNT_ARRESTED');
    await h.drain();
    assert.equal(pick((await readQr(h, small.qrId)).body, 'status'), 'CREATED');
    await h.pool.query("UPDATE accounts SET status = 'ACTIVE' WHERE id = $1", [account.id]);
    assert.equal((await payQr(h, anna, 'pay-data-0005', small.payload, account.id)).status, 201);
    await h.drain();
    assert.equal(pick((await readQr(h, small.qrId)).body, 'status'), 'PAID');
  });

  it('два клиента платят один QR одновременно: проходит одна оплата, вторая получает отказ', async () => {
    const anna = await h.login(ANNA);
    const petr = await h.login(PETR);
    const annaAccount = await accountOf(h, anna);
    const petrAccount = await accountOf(h, petr);
    const qr = await issuedQr(h, { orderId: 'order-race', amount: 10_000 });
    const [first, second] = await Promise.all([
      payQr(h, anna, 'pay-race-0001', qr.payload, annaAccount.id),
      payQr(h, petr, 'pay-race-0002', qr.payload, petrAccount.id),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    await h.drain();
    assert.equal((await h.pool.query("SELECT 1 FROM operations WHERE type = 'QR_PAYMENT'")).rowCount, 1);
    assert.equal(pick((await readQr(h, qr.qrId)).body, 'status'), 'PAID');
    assert.equal((await checkLedger(h.pool)).totalOfBalances, 0n);
  });

  it('заблокированный клиент не платит', async () => {
    const petr = await h.login(PETR);
    const account = await accountOf(h, petr);
    const qr = await issuedQr(h, { orderId: 'order-blocked', amount: 10_000 });
    await h.pool.query("UPDATE clients SET status = 'BLOCKED' WHERE phone = $1", [PETR]);
    const response = await payQr(h, petr, 'pay-blocked-0001', qr.payload, account.id);
    assert.equal(response.status, 403);
    assert.equal(pick(response.body, 'code'), 'CLIENT_BLOCKED');
  });

  it('ключ повтора: тот же запрос возвращает ту же операцию, другое тело с тем же ключом — отказ, второго списания нет', async () => {
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const qr = await issuedQr(h, { orderId: 'order-idem', amount: 10_000 });
    const first = await payQr(h, anna, 'pay-idem-0001', qr.payload, account.id);
    const replay = await payQr(h, anna, 'pay-idem-0001', qr.payload, account.id);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal(pick(replay.body, 'id'), pick(first.body, 'id'));
    await h.drain();
    const other = await issuedQr(h, { orderId: 'order-idem-2', amount: 10_000 });
    const reused = await payQr(h, anna, 'pay-idem-0001', other.payload, account.id);
    assert.equal(reused.status, 422);
    assert.equal(pick(reused.body, 'code'), 'IDEMPOTENCY_KEY_REUSED');
    const withoutKey = await h.api(anna, 'POST', '/api/v1/qr-payments', { payload: qr.payload, accountId: account.id });
    assert.equal(withoutKey.status, 400);
    assert.equal((await accountOf(h, anna)).balance, account.balance - 10_000);
  });

  it('событие bank.payments.created для оплаты по QR соответствует событиям релиза 1.2 и не попадает в метрики переводов', async () => {
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const qr = await issuedQr(h, { orderId: 'order-event', amount: 10_000 });
    const paid = await payQr(h, anna, 'pay-event-0001', qr.payload, account.id);
    const observed: string[] = [];
    await h.drain({ onStatusChanged: (observation) => observed.push(observation.operationNumber) });
    const created = h.events.filter((event) => event.topic === 'bank.payments.created').map((event) => event.payload as Record<string, unknown>);
    const event = created.find((item) => item.operationId === pick(paid.body, 'id'));
    assert.ok(event);
    assert.equal(event.type, 'QR_PAYMENT');
    assert.equal(event.route, 'INTERNAL');
    assert.equal(event.qrId, qr.qrId);
    assert.equal(event.amount, 10_000);
    assert.equal(event.fee, 0);
    assert.equal(event.recipientPhone, null);
    assert.equal(event.recipientBankCode, null);
    assert.equal(event.fromAccount, account.number);
    const validate = loadAsyncApi('1.2').payloadValidator('bank.payments.created');
    assert.deepEqual(validate(event), { ok: true, issues: [] });
    assert.equal(loadAsyncApi('1.0').payloadValidator('bank.payments.created')(event).ok, false);
    assert.deepEqual(observed, []);
    assert.equal(h.events.some((item) => item.topic === 'bank.payments.status-changed' && (item.payload as { operationId: string }).operationId === pick(paid.body, 'id')), true);
  });

  it('обычные переводы по телефону не получают поле qrId в событии и в ответе содержат qrId null', async () => {
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const transfer = await sendTransfer(h, anna, 'qr-plain-phone-001', phoneTransfer(account.number, PETR, 100_000));
    await h.drain();
    assert.equal(pick(transfer.body, 'qrId'), null);
    const created = h.events.find((event) => event.topic === 'bank.payments.created');
    assert.equal('qrId' in (created?.payload as object), false);
  });

  it('офис видит оплату по QR в списке операций и в карточке операции', async () => {
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const qr = await issuedQr(h, { orderId: 'order-office', amount: 10_000 });
    const paid = await payQr(h, anna, 'pay-office-0001', qr.payload, account.id);
    await h.drain();
    const operator = await h.operatorLogin();
    const list = await h.api(operator, 'GET', '/api/v1/office/operations?type=QR_PAYMENT');
    const items = pick(list.body, 'items') as { id: string; type: string; recipient: { displayName: string } }[];
    assert.deepEqual(items.map((item) => [item.id, item.type, item.recipient.displayName]), [[pick(paid.body, 'id'), 'QR_PAYMENT', 'Лавка Гарипова']]);
    const card = await h.api(operator, 'GET', `/api/v1/office/operations/${String(pick(paid.body, 'id'))}`);
    assert.equal(pick(card.body, 'operation.type'), 'QR_PAYMENT');
    assert.equal(pick(card.body, 'operation.qrId'), qr.qrId);
    assert.equal(pick(card.body, 'antifraud.score'), 17);
    const client = await h.api(operator, 'GET', `/api/v1/office/clients/${String(pick((await h.api(anna, 'GET', '/api/v1/me')).body, 'id'))}`);
    assert.ok((pick(client.body, 'recentOperations') as { type: string }[]).some((item) => item.type === 'QR_PAYMENT'));
  });

  it('шаблон из оплаты по QR создать нельзя', async () => {
    const anna = await h.login(ANNA);
    const account = await accountOf(h, anna);
    const qr = await issuedQr(h, { orderId: 'order-template', amount: 10_000 });
    const paid = await payQr(h, anna, 'pay-tmpl-0001', qr.payload, account.id);
    await h.drain();
    const template = await h.api(anna, 'POST', '/api/v1/templates', { name: 'Лавка', fromOperationId: pick(paid.body, 'id') });
    assert.equal(template.status, 422);
    assert.equal(pick(template.body, 'code'), 'OPERATION_NOT_TRANSFER');
  });
});
