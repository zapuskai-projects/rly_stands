import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MIGRATIONS_DIR } from '../config';
import { runMigrations } from '../db/migrate';
import { loadBankClock, shiftBankTime } from '../scenario/bank-time';
import { seedIfEmpty } from '../seed/seed';
import { pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, NEW_OPERATIONS, NOON_MOSCOW, operationOf, PHONES, phoneTransfer, sendTransfer, settledTransfer } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR, GALINA, IP, LI, SERGEY } = PHONES;

describe('переводы через API', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
  });

  afterEach(async () => {
    await h.close();
  });

  const send = (token: string, key: string, body: unknown, headers: Record<string, string> = {}) => sendTransfer(h, token, key, body, headers);

  it('вход по коду из СМС → перевод по телефону проходит антифрод и доходит до COMPLETED, остатки равны проводкам', async () => {
    const anna = await h.login(ANNA);
    const petr = await h.login(PETR);
    const from = await accountOf(h, anna);
    const toBefore = await accountOf(h, petr);

    const created = await send(anna, 'flow-key-0001', phoneTransfer(from.number, PETR, 150_000, { comment: 'За обед' }));
    assert.equal(created.status, 201);
    assert.equal(pick(created.body, 'status'), 'CHECKING');
    assert.equal((await accountOf(h, anna)).available, from.balance - 150_000);
    assert.equal((await accountOf(h, anna)).balance, from.balance);

    await h.drain();
    const finished = await operationOf(h, anna, created);
    assert.equal(pick(finished.body, 'status'), 'COMPLETED');
    assert.equal(pick(finished.body, 'fee'), 0);
    assert.equal(pick(finished.body, 'recipient.displayName'), 'Пётр И.');
    const history = (pick(finished.body, 'statusHistory') as { status: string }[]).map((item) => item.status);
    assert.deepEqual(history, ['CREATED', 'CHECKING', 'PROCESSING', 'COMPLETED']);

    assert.equal((await accountOf(h, anna)).balance, from.balance - 150_000);
    assert.equal((await accountOf(h, petr)).balance, toBefore.balance + 150_000);
    const report = await checkLedger(h.pool);
    assert.deepEqual(report.mismatchedAccounts, []);
    assert.equal(report.totalOfBalances, 0n);
  });

  it('перевод между своими счетами проводится сразу, без антифрода', async () => {
    const anna = await h.login(ANNA);
    const current = await accountOf(h, anna, 0);
    const savings = await accountOf(h, anna, 1);
    const created = await send(anna, 'own-key-0001', { type: 'OWN_TRANSFER', fromAccount: current.number, toAccount: savings.number, amount: 500_000 });
    assert.equal(pick(created.body, 'status'), 'COMPLETED');
    assert.equal((await accountOf(h, anna, 1)).balance, savings.balance + 500_000);
  });

  it('повтор с тем же ключом возвращает ту же операцию и не списывает второй раз', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    const body = phoneTransfer(from.number, PETR, 100_000);
    const first = await send(anna, 'retry-key-0001', body);
    const second = await send(anna, 'retry-key-0001', body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('idempotent-replayed'), 'true');
    assert.equal(pick(second.body, 'id'), pick(first.body, 'id'));
    await h.drain();
    assert.equal((await accountOf(h, anna)).balance, from.balance - 100_000);
    assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 1);
  });

  it('тот же ключ с другим телом отвергается, без ключа — ошибка формата', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    await send(anna, 'retry-key-0002', phoneTransfer(from.number, PETR, 100_000));
    const reused = await send(anna, 'retry-key-0002', phoneTransfer(from.number, PETR, 100_001));
    assert.equal(reused.status, 422);
    assert.equal(pick(reused.body, 'code'), 'IDEMPOTENCY_KEY_REUSED');
    const missing = await h.api(anna, 'POST', '/api/v1/transfers', phoneTransfer(from.number, PETR, 100));
    assert.equal(missing.status, 400);
    assert.equal(pick(missing.body, 'details.0.field'), 'header.Idempotency-Key');
  });

  it('одновременные запросы с одним ключом создают одну операцию', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    const body = phoneTransfer(from.number, PETR, 100_000);
    const responses = await Promise.all(Array.from({ length: 6 }, () => send(anna, 'race-key-0001', body)));
    assert.equal(responses.filter((response) => response.status === 201).length, 1);
    assert.equal(responses.filter((response) => response.status === 200).length, 5);
    assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 1);
    await h.drain();
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('лимит 150 000 ₽ в сутки: ровно до границы проходит, на копейку больше — REJECTED', async () => {
    const petr = await h.login(PETR);
    const from = await accountOf(h, petr);
    const atLimit = await settledTransfer(h, petr, 'limit-key-0001', phoneTransfer(from.number, ANNA, 15_000_000));
    assert.equal(pick(atLimit.body, 'status'), 'COMPLETED');
    const over = await send(petr, 'limit-key-0002', phoneTransfer(from.number, ANNA, 1));
    assert.equal(pick(over.body, 'status'), 'REJECTED');
    assert.equal(pick(over.body, 'rejection.code'), 'DAILY_LIMIT_EXCEEDED');
    assert.equal(pick(over.body, 'fee'), 0);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('перевод на копейку больше лимита отклоняется сразу', async () => {
    const petr = await h.login(PETR);
    const from = await accountOf(h, petr);
    const over = await send(petr, 'limit-key-0003', phoneTransfer(from.number, ANNA, 15_000_001));
    assert.equal(over.status, 201);
    assert.equal(pick(over.body, 'status'), 'REJECTED');
    assert.equal((await accountOf(h, petr)).balance, from.balance);
  });

  it('суточный лимит сбрасывается в полночь по Москве, а не по UTC, и учитывает операции в обработке', async () => {
    const petr = await h.login(PETR);
    const from = await accountOf(h, petr);
    h.setTime(new Date('2026-10-20T20:59:00Z'));
    const lastMinute = await send(petr, 'day-key-0001', phoneTransfer(from.number, ANNA, 15_000_000));
    assert.equal(pick(lastMinute.body, 'status'), 'CHECKING');
    const sameDay = await send(petr, 'day-key-0002', phoneTransfer(from.number, ANNA, 100));
    assert.equal(pick(sameDay.body, 'status'), 'REJECTED');
    h.setTime(new Date('2026-10-20T21:01:00Z'));
    const nextDay = await send(petr, 'day-key-0003', phoneTransfer(from.number, ANNA, 15_000_000));
    assert.equal(pick(nextDay.body, 'status'), 'CHECKING');
    const me = await h.api(petr, 'GET', '/api/v1/me');
    assert.equal(pick(me.body, 'limits.dailyPhoneTransfer.used'), 15_000_000);
    assert.equal(pick(me.body, 'limits.dailyPhoneTransfer.resetsAt'), '2026-10-22T00:00:00.000+03:00');
  });

  it('комиссия только за переводы в другой банк: бесплатно до 100 000 ₽ в месяц, затем 1 % с части сверх квоты, минимум 30 ₽', async () => {
    const ip = await h.login(IP);
    const from = await accountOf(h, ip);
    const toBank = (amount: number) => phoneTransfer(from.number, '+79005550000', amount, { recipientBankCode: 'KEDR' });
    const free = await send(ip, 'fee-key-0001', toBank(9_000_000));
    assert.equal(pick(free.body, 'fee'), 0);
    const partly = await send(ip, 'fee-key-0002', toBank(3_000_000));
    assert.equal(pick(partly.body, 'fee'), 20_000);
    assert.equal(pick(partly.body, 'total'), 3_020_000);
    const minimum = await send(ip, 'fee-key-0003', toBank(100_000));
    assert.equal(pick(minimum.body, 'fee'), 3_000);
    const me = await h.api(ip, 'GET', '/api/v1/me');
    assert.equal(pick(me.body, 'limits.monthlyFreeVolume.used'), 12_100_000);
    assert.equal(pick(me.body, 'limits.monthlyFreeVolume.remaining'), 0);
    const accounts = await h.api(ip, 'GET', '/api/v1/accounts');
    assert.equal(pick(accounts.body, 'items.0.held'), 9_000_000 + 3_020_000 + 103_000);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('внутри ЗапускБанка комиссии нет даже сверх 100 000 ₽ в месяц и квоту не расходует', async () => {
    const petr = await h.login(PETR);
    const from = await accountOf(h, petr);
    const first = await settledTransfer(h, petr, 'inner-key-0001', phoneTransfer(from.number, ANNA, 12_000_000));
    const second = await settledTransfer(h, petr, 'inner-key-0002', phoneTransfer(from.number, ANNA, 3_000_000));
    assert.equal(pick(first.body, 'fee'), 0);
    assert.equal(pick(second.body, 'fee'), 0);
    assert.equal(pick(second.body, 'status'), 'COMPLETED');
    const me = await h.api(petr, 'GET', '/api/v1/me');
    assert.equal(pick(me.body, 'limits.monthlyFreeVolume.used'), 0);
    assert.equal(pick(me.body, 'limits.monthlyFreeVolume.remaining'), 10_000_000);
    assert.equal(pick(me.body, 'limits.dailyPhoneTransfer.used'), 15_000_000);
    const income = await h.pool.query("SELECT balance_kop FROM accounts WHERE kind = 'INCOME'");
    assert.equal(income.rows[0].balance_kop, 0n);
    const sbp = await send(petr, 'inner-key-0003', phoneTransfer(from.number, '+79005550000', 100_000, { recipientBankCode: 'KEDR' }));
    assert.equal(pick(sbp.body, 'status'), 'REJECTED');
  });

  it('нехватка средств даёт 422 и не создаёт операцию', async () => {
    const anna = await h.login(ANNA);
    const savings = await accountOf(h, anna, 1);
    const current = await accountOf(h, anna, 0);
    const response = await send(anna, 'funds-key-0001', {
      type: 'OWN_TRANSFER',
      fromAccount: savings.number,
      toAccount: current.number,
      amount: savings.balance + 1,
    });
    assert.equal(response.status, 422);
    assert.equal(pick(response.body, 'code'), 'INSUFFICIENT_FUNDS');
    assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 0);
    assert.equal((await h.pool.query('SELECT 1 FROM outbox_events')).rowCount, 0);
  });

  it('перевод в другой банк держит средства на холде, пока СБП не ответила', async () => {
    const galina = await h.login(GALINA);
    const from = await accountOf(h, galina);
    const created = await send(galina, 'sbp-key-0001', phoneTransfer(from.number, '+79005550000', 5_000_000, { recipientBankCode: 'KEDR' }));
    await h.drain({ sbp: false });
    const operation = await operationOf(h, galina, created);
    assert.equal(pick(operation.body, 'status'), 'PROCESSING');
    assert.equal(pick(operation.body, 'route'), 'SBP');
    const accounts = await h.api(galina, 'GET', '/api/v1/accounts');
    assert.equal(pick(accounts.body, 'items.0.balance'), from.balance);
    assert.equal(pick(accounts.body, 'items.0.held'), 5_000_000);
    assert.equal(pick(accounts.body, 'items.0.available'), from.balance - 5_000_000);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('арест счёта и запрет нерезиденту дают REJECTED без движения денег', async () => {
    const sergey = await h.login(SERGEY);
    const arrested = await send(sergey, 'rule-key-0001', phoneTransfer((await accountOf(h, sergey)).number, ANNA, 100));
    assert.equal(pick(arrested.body, 'rejection.code'), 'ACCOUNT_ARRESTED');
    const li = await h.login(LI);
    const external = await send(li, 'rule-key-0002', phoneTransfer((await accountOf(h, li)).number, ANNA, 100, { recipientBankCode: 'KEDR' }));
    assert.equal(pick(external.body, 'rejection.code'), 'NON_RESIDENT_EXTERNAL_TRANSFER');
    const internal = await settledTransfer(h, li, 'rule-key-0003', phoneTransfer((await accountOf(h, li)).number, ANNA, 100));
    assert.equal(pick(internal.body, 'status'), 'COMPLETED');
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('пенсионный лимит 50 000 ₽: граница', async () => {
    const galina = await h.login(GALINA);
    const from = await accountOf(h, galina);
    const atLimit = await settledTransfer(h, galina, 'pension-key-0001', phoneTransfer(from.number, ANNA, 5_000_000));
    assert.equal(pick(atLimit.body, 'status'), 'COMPLETED');
    const over = await send(galina, 'pension-key-0002', phoneTransfer(from.number, ANNA, 1));
    assert.equal(pick(over.body, 'status'), 'REJECTED');
  });

  it('чужие операции и счета не видны', async () => {
    const anna = await h.login(ANNA);
    const petr = await h.login(PETR);
    const created = await send(anna, 'scope-key-0001', phoneTransfer((await accountOf(h, anna)).number, PETR, 100));
    const foreign = await h.api(petr, 'GET', `/api/v1/operations/${String(pick(created.body, 'id'))}`);
    assert.equal(foreign.status, 404);
    const annaAccount = await accountOf(h, anna);
    const foreignAccount = await h.api(petr, 'GET', `/api/v1/accounts/${annaAccount.id}`);
    assert.equal(foreignAccount.status, 404);
  });

  it('выписка: остатки на начало и конец считаются по проводкам', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    await settledTransfer(h, anna, 'stmt-key-0001', phoneTransfer(from.number, PETR, 250_000));
    const statement = await h.api(anna, 'GET', `/api/v1/accounts/${from.id}/statement?from=2026-10-20&to=2026-10-20`);
    assert.equal(statement.status, 200);
    assert.equal(pick(statement.body, 'openingBalance'), from.balance);
    assert.equal(pick(statement.body, 'closingBalance'), from.balance - 250_000);
    assert.equal(pick(statement.body, 'totalDebit'), 250_000);
    assert.equal(pick(statement.body, 'totalCredit'), 0);
    const entries = pick(statement.body, 'entries') as { balanceAfter: number }[];
    assert.equal(entries.at(-1)?.balanceAfter, from.balance - 250_000);
    const invalid = await h.api(anna, 'GET', `/api/v1/accounts/${from.id}/statement?from=2026-10-21&to=2026-10-20`);
    assert.equal(invalid.status, 400);
  });

  it('история операций: фильтры по статусу, виду, номеру и датам, постраничный вывод', async () => {
    const petr = await h.login(PETR);
    const from = await accountOf(h, petr);
    const savings = await accountOf(h, petr, 1);
    const done = await send(petr, 'list-key-0001', phoneTransfer(from.number, ANNA, 100_000));
    const rejected = await send(petr, 'list-key-0002', phoneTransfer(from.number, ANNA, 15_000_000));
    h.setTime(new Date('2026-10-21T09:00:00Z'));
    const own = await send(petr, 'list-key-0003', { type: 'OWN_TRANSFER', fromAccount: from.number, toAccount: savings.number, amount: 5_000 });

    const all = await h.api(petr, 'GET', '/api/v1/operations');
    assert.equal(pick(all.body, 'total'), 3);
    assert.deepEqual((pick(all.body, 'items') as { id: string }[]).map((item) => item.id), [
      pick(own.body, 'id'),
      pick(rejected.body, 'id'),
      pick(done.body, 'id'),
    ]);
    const byStatus = await h.api(petr, 'GET', '/api/v1/operations?status=REJECTED');
    assert.equal(pick(byStatus.body, 'total'), 1);
    const byType = await h.api(petr, 'GET', '/api/v1/operations?type=OWN_TRANSFER');
    assert.equal(pick(byType.body, 'items.0.id'), pick(own.body, 'id'));
    const byNumber = await h.api(petr, 'GET', `/api/v1/operations?number=${String(pick(done.body, 'number'))}`);
    assert.equal(pick(byNumber.body, 'total'), 1);
    const firstDay = await h.api(petr, 'GET', '/api/v1/operations?from=2026-10-20&to=2026-10-20');
    assert.equal(pick(firstDay.body, 'total'), 2);
    const page = await h.api(petr, 'GET', '/api/v1/operations?limit=1&offset=1');
    assert.equal(pick(page.body, 'items.0.id'), pick(rejected.body, 'id'));
    assert.equal(pick(page.body, 'total'), 3);
    assert.equal((await h.api(petr, 'GET', '/api/v1/operations?limit=0')).status, 400);
    assert.equal((await h.api(petr, 'GET', '/api/v1/operations?status=UNKNOWN')).status, 400);
    assert.equal((await h.api(petr, 'GET', '/api/v1/operations?from=2026-10-21&to=2026-10-20')).status, 400);
  });

  it('поломанный JSON и пустое тело отвечают ошибкой формата', async () => {
    const anna = await h.login(ANNA);
    const broken = await fetch(`${h.baseUrl}/api/v1/transfers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${anna}`, 'content-type': 'application/json', 'idempotency-key': 'broken-key-0001' },
      body: '{"type": ',
    });
    assert.equal(broken.status, 400);
    assert.equal(((await broken.json()) as { code: string }).code, 'MALFORMED_JSON');
    const empty = await send(anna, 'empty-key-0001', undefined);
    assert.equal(empty.status, 400);
    assert.equal(pick(empty.body, 'details.0.field'), 'body');
  });

  it('журнал запросов хранит метод, путь, статус, ключ повтора и метку', async () => {
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    await send(anna, 'journal-key-0001', phoneTransfer(from.number, PETR, 100), { 'X-Attempt-Label': 'attempt-42' });
    const deadline = Date.now() + 3000;
    let rows = (await h.pool.query("SELECT * FROM request_log WHERE attempt_label = 'attempt-42'")).rows;
    while (rows.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      rows = (await h.pool.query("SELECT * FROM request_log WHERE attempt_label = 'attempt-42'")).rows;
    }
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].method, rows[0].path, rows[0].status, rows[0].idempotency_key], ['POST', '/api/v1/transfers', 201, 'journal-key-0001']);
    assert.ok(rows[0].operation_id);
  });

  it('банковское время сдвигается и переживает перезапуск', async () => {
    await shiftBankTime(h.pool, h.clock, new Date('2026-10-20T20:40:00Z'));
    const restored = await loadBankClock(h.pool);
    assert.equal(restored.getOffsetMs(), h.clock.getOffsetMs());
    assert.equal(restored.getOffsetMs(), new Date('2026-10-20T20:40:00Z').getTime() - NOON_MOSCOW.getTime());
    await shiftBankTime(h.pool, h.clock, null);
    assert.equal((await loadBankClock(h.pool)).getOffsetMs(), 0);
  });

  it('повторный запуск миграций и сида ничего не меняет', async () => {
    assert.deepEqual(await runMigrations(h.pool, MIGRATIONS_DIR), []);
    assert.equal(await seedIfEmpty(h.pool, h.clock), false);
    assert.equal((await h.pool.query('SELECT 1 FROM clients')).rowCount, 6);
  });

  it('неизвестный маршрут и неверный токен отвечают ошибкой по контракту', async () => {
    const missing = await h.api(null, 'GET', '/api/v1/unknown');
    assert.equal(missing.status, 404);
    assert.equal(pick(missing.body, 'code'), 'NOT_FOUND');
    const unauthorized = await h.api('zb_wrong', 'GET', '/api/v1/accounts');
    assert.equal(unauthorized.status, 401);
    const logout = await h.login(ANNA);
    assert.equal((await h.api(logout, 'POST', '/api/v1/auth/logout')).status, 204);
    assert.equal((await h.api(logout, 'GET', '/api/v1/accounts')).status, 401);
  });

  it('код входа: неверный код тратит попытку, после пяти — блокировка', async () => {
    const challenge = await h.api(null, 'POST', '/api/v1/auth/login', { phone: ANNA });
    const challengeId = pick(challenge.body, 'challengeId');
    const first = await h.api(null, 'POST', '/api/v1/auth/verify', { challengeId, code: '000000' });
    assert.equal(first.status, 401);
    assert.equal(pick(first.body, 'code'), 'INVALID_CODE');
    for (let i = 0; i < 4; i += 1) await h.api(null, 'POST', '/api/v1/auth/verify', { challengeId, code: '000000' });
    const locked = await h.api(null, 'POST', '/api/v1/auth/verify', { challengeId, code: '000000' });
    assert.equal(pick(locked.body, 'code'), 'CODE_ATTEMPTS_EXCEEDED');
    const unknown = await h.api(null, 'POST', '/api/v1/auth/login', { phone: '+79990000000' });
    assert.equal(unknown.status, 404);
  });
});
