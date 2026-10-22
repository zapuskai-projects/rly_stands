import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pick, startHarness, type ApiResponse, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, NIGHT_MOSCOW, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer, settledTransfer } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const MINUTE = 60_000;

describe('антифрод и ручная проверка', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;
  let anna: string;
  let operator: string;

  async function startAt(instant: Date): Promise<void> {
    h = await startHarness(DATABASE_URL as string, instant);
    anna = await h.login(ANNA);
    operator = await h.operatorLogin();
  }

  afterEach(async () => {
    await h.close();
  });

  async function nightTransferOnReview(key = 'night-key-0001'): Promise<{ created: ApiResponse; operationId: string; from: string }> {
    const from = await accountOf(h, anna);
    const created = await sendTransfer(h, anna, key, phoneTransfer(from.number, PETR, 1_500_000), { 'X-Request-Id': 'req-night-0001' });
    await h.drain();
    return { created, operationId: String(pick(created.body, 'id')), from: from.number };
  }

  const operation = (operationId: string) => h.api(anna, 'GET', `/api/v1/operations/${operationId}`);
  const review = (operationId: string, action: 'approve' | 'reject', body?: unknown, headers: Record<string, string> = {}, token: string | null = operator) =>
    h.api(token, 'POST', `/api/v1/office/reviews/${operationId}/${action}`, body, headers);

  describe('ночной перевод новому получателю', () => {
    beforeEach(() => startAt(NIGHT_MOSCOW));

    it('уходит на ручную проверку: оценка 72, три сработавших правила, срок 30 минут, средства на холде', async () => {
      const { operationId } = await nightTransferOnReview();
      const current = await operation(operationId);
      assert.equal(pick(current.body, 'status'), 'ON_REVIEW');
      const history = (pick(current.body, 'statusHistory') as { status: string; reasonCode: string | null }[]).map((item) => item.status);
      assert.deepEqual(history, ['CREATED', 'CHECKING', 'ON_REVIEW']);

      const decision = await h.pool.query('SELECT score, decision, rules FROM antifraud_decisions WHERE operation_id = $1', [operationId]);
      assert.equal(decision.rows[0].score, 72);
      assert.equal(decision.rows[0].decision, 'REVIEW');
      assert.deepEqual((decision.rows[0].rules as { code: string }[]).map((rule) => rule.code), ['NEW_RECIPIENT', 'NIGHT_TIME', 'AMOUNT_ABOVE_USUAL']);

      const queue = await h.api(operator, 'GET', '/api/v1/office/reviews?state=PENDING');
      assert.equal(pick(queue.body, 'total'), 1);
      assert.equal(pick(queue.body, 'items.0.operationId'), operationId);
      assert.equal(pick(queue.body, 'items.0.score'), 72);
      assert.equal(pick(queue.body, 'items.0.rules.1.description'), 'Перевод ночью, с 23:00 до 06:00 по Москве');
      assert.equal(pick(queue.body, 'items.0.deadlineAt'), '2026-10-21T00:10:00.000+03:00');
      assert.equal(pick(queue.body, 'items.0.clientName'), 'Анна Соколова');

      const account = await accountOf(h, anna);
      assert.equal(account.held, 1_500_000);
      assert.equal(account.available, account.balance - 1_500_000);
      const notifications = await h.pool.query('SELECT 1 FROM notifications WHERE operation_id = $1', [operationId]);
      assert.equal(notifications.rowCount, 0);
    });

    it('оператор одобряет: перевод доходит до COMPLETED, уведомления приходят только после проведения', async () => {
      const { operationId } = await nightTransferOnReview();
      const approved = await review(operationId, 'approve', { comment: 'Клиент подтвердил по телефону' }, { 'X-Request-Id': 'req-approve-0001' });
      assert.equal(approved.status, 200);
      assert.equal(pick(approved.body, 'state'), 'APPROVED');
      assert.equal(pick(approved.body, 'resolvedBy'), 'operator');
      assert.equal(pick(approved.body, 'comment'), 'Клиент подтвердил по телефону');
      assert.equal(pick((await operation(operationId)).body, 'status'), 'COMPLETED');

      const before = await h.pool.query('SELECT 1 FROM notifications WHERE operation_id = $1', [operationId]);
      assert.equal(before.rowCount, 0);
      await h.drain();
      const rows = await h.pool.query(
        `SELECT n.channel, n.kind, n.created_at, o.completed_at FROM notifications n JOIN operations o ON o.id = n.operation_id
         WHERE n.operation_id = $1 ORDER BY n.id`,
        [operationId],
      );
      assert.deepEqual(rows.rows.map((row) => `${row.kind}:${row.channel}`).sort(), [
        'TRANSFER_COMPLETED:PUSH',
        'TRANSFER_COMPLETED:SMS',
        'TRANSFER_RECEIVED:PUSH',
        'TRANSFER_RECEIVED:SMS',
      ]);
      for (const row of rows.rows) assert.ok(row.created_at >= row.completed_at);

      const actor = await h.pool.query("SELECT actor FROM operation_status_history WHERE operation_id = $1 AND status = 'PROCESSING'", [operationId]);
      assert.equal(actor.rows[0].actor, 'OPERATOR:operator');
      const report = await checkLedger(h.pool);
      assert.deepEqual(report.mismatchedAccounts, []);
      assert.equal(report.totalOfBalances, 0n);
    });

    it('оператор отклоняет с комментарием: статус REJECTED, холд снят, повторное действие — 409', async () => {
      const { operationId, from } = await nightTransferOnReview();
      const balanceBefore = (await accountOf(h, anna)).balance;
      assert.equal((await review(operationId, 'reject', {})).status, 400);
      assert.equal((await review(operationId, 'reject', { comment: 'ab' })).status, 400);
      const rejected = await review(operationId, 'reject', { comment: 'Клиент не подтвердил перевод' });
      assert.equal(rejected.status, 200);
      assert.equal(pick(rejected.body, 'state'), 'REJECTED');

      const current = await operation(operationId);
      assert.equal(pick(current.body, 'status'), 'REJECTED');
      assert.equal(pick(current.body, 'rejection.code'), 'OPERATOR_REJECTED');
      assert.equal(pick(current.body, 'rejection.message'), 'Клиент не подтвердил перевод');
      assert.equal(pick(current.body, 'fee'), 0);
      const account = await accountOf(h, anna);
      assert.equal(account.held, 0);
      assert.equal(account.balance, balanceBefore);
      assert.equal(account.number, from);

      const again = await review(operationId, 'approve');
      assert.equal(again.status, 409);
      assert.equal(pick(again.body, 'code'), 'REVIEW_ALREADY_RESOLVED');
      assert.equal((await review('00000000-0000-4000-8000-000000000000', 'approve')).status, 404);
      await h.drain();
      assert.equal((await h.pool.query('SELECT 1 FROM notifications WHERE operation_id = $1', [operationId])).rowCount, 0);
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
    });

    it('без токена оператора и с токеном клиента действия недоступны', async () => {
      const { operationId } = await nightTransferOnReview();
      assert.equal((await review(operationId, 'approve', undefined, {}, null)).status, 401);
      assert.equal((await review(operationId, 'approve', undefined, {}, anna)).status, 401);
      assert.equal((await h.api(null, 'GET', '/api/v1/office/reviews')).status, 401);
      const wrong = await h.api(null, 'POST', '/api/v1/office/auth/login', { login: 'operator', password: 'неверный' });
      assert.equal(wrong.status, 401);
      assert.equal(pick(wrong.body, 'code'), 'INVALID_CREDENTIALS');
      assert.equal((await h.api(operator, 'GET', '/api/v1/accounts')).status, 401);
    });

    it('просрочка 30 минут банковского времени: перевод отклоняется, холд снимается', async () => {
      const { operationId } = await nightTransferOnReview();
      h.setTime(new Date(NIGHT_MOSCOW.getTime() + 29 * MINUTE + 59_000));
      assert.equal(await h.expireReviews(), 0);
      assert.equal(pick((await operation(operationId)).body, 'status'), 'ON_REVIEW');
      h.setTime(new Date(NIGHT_MOSCOW.getTime() + 30 * MINUTE));
      assert.equal(await h.expireReviews(), 1);

      const current = await operation(operationId);
      assert.equal(pick(current.body, 'status'), 'REJECTED');
      assert.equal(pick(current.body, 'rejection.code'), 'REVIEW_EXPIRED');
      assert.equal((await accountOf(h, anna)).held, 0);
      const state = await h.pool.query('SELECT state, resolved_by FROM manual_reviews WHERE operation_id = $1', [operationId]);
      assert.deepEqual([state.rows[0].state, state.rows[0].resolved_by], ['EXPIRED', 'SYSTEM']);
      assert.equal(await h.expireReviews(), 0);
      assert.equal((await review(operationId, 'approve')).status, 409);
    });

    it('одобрение после срока, пока проверку не закрыл сторож, тоже отклоняет перевод', async () => {
      const { operationId } = await nightTransferOnReview();
      h.setTime(new Date(NIGHT_MOSCOW.getTime() + 31 * MINUTE));
      const late = await review(operationId, 'approve');
      assert.equal(late.status, 409);
      assert.equal(pick(late.body, 'code'), 'REVIEW_EXPIRED');
      assert.equal(pick((await operation(operationId)).body, 'rejection.code'), 'REVIEW_EXPIRED');
      assert.equal((await accountOf(h, anna)).held, 0);
    });

    it('ночной перевод в другой банк после одобрения идёт в СБП и завершается', async () => {
      const from = await accountOf(h, anna);
      const created = await sendTransfer(h, anna, 'night-sbp-0001', phoneTransfer(from.number, '+79005550000', 1_500_000, { recipientBankCode: 'KEDR' }));
      await h.drain();
      const operationId = String(pick(created.body, 'id'));
      assert.equal(pick((await operation(operationId)).body, 'status'), 'ON_REVIEW');
      assert.equal((await review(operationId, 'approve')).status, 200);
      assert.equal(pick((await operation(operationId)).body, 'status'), 'PROCESSING');
      await h.drain();
      assert.equal(pick((await operation(operationId)).body, 'status'), 'COMPLETED');
      assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
    });

    it('запросы оператора попадают в журнал запросов вместе с отказами', async () => {
      const { operationId } = await nightTransferOnReview();
      await review(operationId, 'approve', { comment: 'ok' }, { 'X-Attempt-Label': 'office-run-1' });
      await review(operationId, 'approve', undefined, { 'X-Attempt-Label': 'office-run-1' });
      await h.api(operator, 'GET', '/api/v1/office/reviews', undefined, { 'X-Attempt-Label': 'office-run-1' });
      const deadline = Date.now() + 3000;
      let rows = (await h.pool.query("SELECT method, path, status, operation_id FROM request_log WHERE attempt_label = 'office-run-1' ORDER BY id")).rows;
      while (rows.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        rows = (await h.pool.query("SELECT method, path, status, operation_id FROM request_log WHERE attempt_label = 'office-run-1' ORDER BY id")).rows;
      }
      assert.deepEqual(rows.map((row) => [row.method, row.path, row.status]), [
        ['POST', `/api/v1/office/reviews/${operationId}/approve`, 200],
        ['POST', `/api/v1/office/reviews/${operationId}/approve`, 409],
        ['GET', '/api/v1/office/reviews', 200],
      ]);
      assert.equal(rows[0].operation_id, operationId);
    });
  });

  describe('правила и пороги', () => {
    beforeEach(() => startAt(NOON_MOSCOW));

    it('днём перевод новому получателю у клиента с историей набирает 30 и проходит без проверки', async () => {
      const from = await accountOf(h, anna);
      const created = await settledTransfer(h, anna, 'day-key-0001', phoneTransfer(from.number, PETR, 100_000));
      assert.equal(pick(created.body, 'status'), 'COMPLETED');
      const decision = await h.pool.query('SELECT score FROM antifraud_decisions');
      assert.equal(decision.rows[0].score, 30);
    });

    it('порог отказа настраивается: оценка выше порога — REJECTED, холд снят', async () => {
      await h.pool.query('UPDATE antifraud_settings SET review_threshold = 20, reject_threshold = 30');
      const from = await accountOf(h, anna);
      const created = await settledTransfer(h, anna, 'reject-key-0001', phoneTransfer(from.number, PETR, 100_000));
      assert.equal(pick(created.body, 'status'), 'REJECTED');
      assert.equal(pick(created.body, 'rejection.code'), 'ANTIFRAUD_REJECTED');
      assert.equal((await accountOf(h, anna)).held, 0);
      assert.equal((await accountOf(h, anna)).balance, from.balance);
    });

    it('порог проверки настраивается: оценка 30 при пороге 25 уходит на ручную проверку', async () => {
      await h.pool.query('UPDATE antifraud_settings SET review_threshold = 25, reject_threshold = 60');
      const from = await accountOf(h, anna);
      const created = await settledTransfer(h, anna, 'review-key-0001', phoneTransfer(from.number, PETR, 100_000));
      assert.equal(pick(created.body, 'status'), 'ON_REVIEW');
    });

    it('пороги нельзя задать наоборот', async () => {
      await assert.rejects(h.pool.query('UPDATE antifraud_settings SET review_threshold = 95, reject_threshold = 90'));
    });

    it('сумма больше обычной в 3 раза и шестой перевод за час срабатывают отдельными правилами', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      for (let i = 1; i <= 4; i += 1) await settledTransfer(h, petr, `usual-key-000${i}`, phoneTransfer(from.number, ANNA, 10_000));
      const large = await settledTransfer(h, petr, 'usual-key-0005', phoneTransfer(from.number, ANNA, 30_001));
      const sixth = await settledTransfer(h, petr, 'usual-key-0006', phoneTransfer(from.number, ANNA, 10_000));
      const decisions = h.events.filter((event) => event.topic === 'bank.antifraud.decisions').map((event) => event.payload as { operationNumber: string; rules: { code: string }[] });
      const codesFor = (response: ApiResponse) => decisions.find((item) => item.operationNumber === pick(response.body, 'number'))?.rules.map((rule) => rule.code);
      assert.deepEqual(codesFor(large), ['AMOUNT_ABOVE_USUAL']);
      assert.deepEqual(codesFor(sixth), ['HIGH_FREQUENCY']);
      assert.equal(pick(sixth.body, 'status'), 'COMPLETED');
    });

    it('первый перевод клиента без истории считается больше обычной суммы', async () => {
      const petr = await h.login(PETR);
      const from = await accountOf(h, petr);
      await settledTransfer(h, petr, 'first-key-0001', phoneTransfer(from.number, ANNA, 10_000));
      const decision = h.events.find((event) => event.topic === 'bank.antifraud.decisions')?.payload as { score: number; rules: { code: string }[] };
      assert.equal(decision.score, 47);
      assert.deepEqual(decision.rules.map((rule) => rule.code), ['NEW_RECIPIENT', 'AMOUNT_ABOVE_USUAL']);
    });
  });

  describe('события и уведомления', () => {
    beforeEach(() => startAt(NOON_MOSCOW));

    it('сбой брокера не теряет события: перевод ждёт в CHECKING и завершается после восстановления', async () => {
      const from = await accountOf(h, anna);
      const created = await sendTransfer(h, anna, 'outbox-key-0001', phoneTransfer(from.number, PETR, 100_000));
      await h.drain({ brokerDown: true });
      const stuck = await h.api(anna, 'GET', `/api/v1/operations/${String(pick(created.body, 'id'))}`);
      assert.equal(pick(stuck.body, 'status'), 'CHECKING');
      assert.equal(h.events.length, 0);
      const pending = await h.pool.query('SELECT attempts, last_error FROM outbox_events WHERE published_at IS NULL ORDER BY id LIMIT 1');
      assert.ok(pending.rows[0].attempts >= 1);
      assert.match(pending.rows[0].last_error, /брокер недоступен/);
      await h.drain();
      const done = await h.api(anna, 'GET', `/api/v1/operations/${String(pick(created.body, 'id'))}`);
      assert.equal(pick(done.body, 'status'), 'COMPLETED');
      assert.equal((await h.pool.query('SELECT 1 FROM outbox_events WHERE published_at IS NULL')).rowCount, 0);
    });

    it('откат транзакции не оставляет событий в очереди', async () => {
      const savings = await accountOf(h, anna, 1);
      await sendTransfer(h, anna, 'rollback-key-0001', { type: 'OWN_TRANSFER', fromAccount: savings.number, toAccount: savings.number, amount: 100 });
      assert.equal((await h.pool.query('SELECT 1 FROM outbox_events')).rowCount, 0);
    });
  });
});
