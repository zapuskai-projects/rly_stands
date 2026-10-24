import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { findSystemAccount } from '../accounts/accounts.repository';
import { postEntries } from '../accounts/ledger';
import { loadAsyncApi } from '../testing/asyncapi';
import { autopayEvents, autopaymentOf, makeAutopayment, makeTemplate, notificationTexts, runsOf, tick } from '../testing/autopay';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { startAttempt } from './autopay-runner';
import { accountOf, moscow, NEW_OPERATIONS, NOON_MOSCOW, PHONES, useRelease } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const RENT = 2_500_000;

describe('автоплатежи: расписание, повторы, события и уведомления', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
    await useRelease(h, '1.1');
  });

  afterEach(async () => {
    await h.close();
  });

  async function annaRent(amount: number = RENT, day = 21, extra: Record<string, unknown> = {}, name = 'Аренда') {
    const token = await h.login(ANNA);
    const from = await accountOf(h, token);
    const templateId = await makeTemplate(h, token, { name, kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR, amount });
    const created = await makeAutopayment(h, token, { templateId, dayOfMonth: day, ...extra });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { token, from, templateId, id: String(pick(created.body, 'id')), created };
  }

  it('создание: сумма шаблона или запроса, ближайший день платежа, проверки формата и шаблона', async () => {
    const token = await h.login(ANNA);
    const from = await accountOf(h, token);
    const withAmount = await makeTemplate(h, token, { name: 'С суммой', kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR, amount: RENT });
    const withoutAmount = await makeTemplate(h, token, { name: 'Без суммы', kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR });

    const later = await makeAutopayment(h, token, { templateId: withAmount, dayOfMonth: 25 });
    assert.equal(later.status, 201);
    assert.deepEqual(
      ['status', 'amount', 'nextRunOn', 'attempt', 'dayOfMonth', 'endsOn', 'failureReason', 'templateName'].map((field) => pick(later.body, field)),
      ['ACTIVE', RENT, '2026-10-25', 0, 25, null, null, 'С суммой'],
    );
    assert.equal(pick((await makeAutopayment(h, token, { templateId: withAmount, dayOfMonth: 20 })).body, 'nextRunOn'), '2026-11-20');
    assert.equal(pick((await makeAutopayment(h, token, { templateId: withAmount, dayOfMonth: 5, amount: 99_000 })).body, 'amount'), 99_000);
    assert.equal(pick((await makeAutopayment(h, token, { templateId: withoutAmount, dayOfMonth: 5, amount: 77_000 })).body, 'amount'), 77_000);

    const required = await makeAutopayment(h, token, { templateId: withoutAmount, dayOfMonth: 5 });
    assert.equal(required.status, 422);
    assert.equal(pick(required.body, 'code'), 'AMOUNT_REQUIRED');
    for (const dayOfMonth of [0, 29, 31]) assert.equal((await makeAutopayment(h, token, { templateId: withAmount, dayOfMonth })).status, 400, String(dayOfMonth));
    assert.equal(pick(await makeAutopayment(h, token, { templateId: '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', dayOfMonth: 5 }), 'body.code'), 'TEMPLATE_NOT_FOUND');
    for (const endsOn of ['2026-10-24', '2026-02-30', '24.10.2026']) {
      assert.equal((await makeAutopayment(h, token, { templateId: withAmount, dayOfMonth: 25, endsOn })).status, 400, endsOn);
    }
    assert.equal((await makeAutopayment(h, token, { templateId: withAmount, dayOfMonth: 25, endsOn: '2026-10-25' })).status, 201);

    const petr = await h.login(PETR);
    assert.equal((await makeAutopayment(h, petr, { templateId: withAmount, dayOfMonth: 5 })).status, 404);
    assert.equal(((await h.api(petr, 'GET', '/api/v1/autopayments')).body as { items: unknown[] }).items.length, 0);
  });

  it('платёж исполняется в 10:00 дня платежа: ни раньше, ни без дня; деньги, операция, событие, уведомления, следующая дата через месяц', async () => {
    const { token, from, templateId, id } = await annaRent();
    h.setTime(moscow('2026-10-21T09:59:00'));
    await tick(h);
    assert.deepEqual(await runsOf(h, token, id), []);
    assert.equal((await accountOf(h, token)).balance, from.balance);

    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    const runs = await runsOf(h, token, id);
    assert.equal(runs.length, 1);
    const run = runs[0] as Record<string, unknown>;
    assert.deepEqual([run.runDate, run.attempt, run.outcome, run.reasonCode, run.amount], ['2026-10-21', 1, 'EXECUTED', null, RENT]);
    const autopayment = await autopaymentOf(h, token, id);
    assert.deepEqual([autopayment.status, autopayment.nextRunOn, autopayment.attempt, autopayment.failureReason], ['ACTIVE', '2026-11-21', 0, null]);
    assert.equal((await accountOf(h, token)).balance, from.balance - RENT);

    const operation = await h.api(token, 'GET', `/api/v1/operations/${String(run.operationId)}`);
    assert.equal(pick(operation.body, 'status'), 'COMPLETED');
    assert.equal(pick(operation.body, 'templateId'), templateId);
    assert.equal(pick(operation.body, 'number'), run.operationNumber);

    const events = autopayEvents(h);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.key, '10000001');
    assert.deepEqual(
      ['autopaymentId', 'runId', 'runDate', 'attempt', 'outcome', 'operationId', 'operationNumber', 'reasonCode', 'amount', 'currency'].map((field) => events[0]?.payload[field]),
      [id, run.id, '2026-10-21', 1, 'EXECUTED', run.operationId, run.operationNumber, null, RENT, 'RUB'],
    );
    assert.equal(events[0]?.headers.autopaymentId, id);
    assert.equal(events[0]?.headers.operationId, run.operationId);
    assert.equal(loadAsyncApi('1.1').payloadValidator('bank.autopayments.executed')(events[0]?.payload).ok, true);

    const texts = await notificationTexts(h, ANNA, 'AUTOPAYMENT_EXECUTED');
    assert.equal(texts.length, 2);
    assert.match(texts[0] as string, /автоплатёж «Аренда» выполнен: 25 000,00 ₽\. Операция ZB/);
    assert.equal((await notificationTexts(h, ANNA, 'TRANSFER_COMPLETED')).length, 2);
    assert.equal(loadAsyncApi('1.1').payloadValidator('bank.notifications')(h.events.find((event) => event.topic === 'bank.notifications' && (event.payload as { kind: string }).kind === 'AUTOPAYMENT_EXECUTED')?.payload).ok, true);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('нехватка денег: три попытки в три дня, потом FAILED; ни одной операции, деньги на месте, на каждую попытку событие и уведомление', async () => {
    const { token, from, id } = await annaRent(13_000_000);
    const schedule: [string, string, string | null][] = [
      ['2026-10-21T10:00:00', '2026-10-22', 'ACTIVE'],
      ['2026-10-22T10:00:00', '2026-10-23', 'ACTIVE'],
      ['2026-10-23T10:00:00', 'null', 'FAILED'],
    ];
    for (const [index, [moment, nextRunOn, status]] of schedule.entries()) {
      h.setTime(moscow(moment));
      await tick(h);
      const autopayment = await autopaymentOf(h, token, id);
      assert.deepEqual([autopayment.status, autopayment.attempt, autopayment.failureReason, autopayment.nextRunOn ?? 'null'], [status, index + 1, 'INSUFFICIENT_FUNDS', nextRunOn], moment);
    }
    const runs = await runsOf(h, token, id);
    assert.deepEqual(runs.map((run) => [run.runDate, run.attempt, run.outcome, run.reasonCode, run.operationId]).reverse(), [
      ['2026-10-21', 1, 'FAILED', 'INSUFFICIENT_FUNDS', null],
      ['2026-10-22', 2, 'FAILED', 'INSUFFICIENT_FUNDS', null],
      ['2026-10-23', 3, 'FAILED', 'INSUFFICIENT_FUNDS', null],
    ]);
    const keys = await h.pool.query<{ idempotency_key: string }>('SELECT idempotency_key FROM autopayment_runs ORDER BY attempt');
    assert.deepEqual(keys.rows.map((row) => row.idempotency_key), [`autopay:${id}:2026-10-21:1`, `autopay:${id}:2026-10-21:2`, `autopay:${id}:2026-10-21:3`]);

    assert.equal((await accountOf(h, token)).balance, from.balance);
    assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 0);
    assert.deepEqual(autopayEvents(h).map((event) => [event.payload.attempt, event.payload.outcome, event.payload.reasonCode, event.payload.operationId]), [
      [1, 'FAILED', 'INSUFFICIENT_FUNDS', null],
      [2, 'FAILED', 'INSUFFICIENT_FUNDS', null],
      [3, 'FAILED', 'INSUFFICIENT_FUNDS', null],
    ]);
    const failures = await notificationTexts(h, ANNA, 'AUTOPAYMENT_FAILED');
    assert.equal(failures.length, 6);
    assert.match(failures[0] as string, /недостаточно средств на счёте\. Повторим 22 октября в 10:00, попытка 2 из 3\./);
    assert.match(failures[2] as string, /Повторим 23 октября в 10:00, попытка 3 из 3\./);
    assert.match(failures[4] as string, /Автоплатёж остановлен: возобновить его можно в интернет-банке\./);

    h.setTime(moscow('2026-10-24T10:00:00'));
    await tick(h);
    assert.equal((await runsOf(h, token, id)).length, 3);

    const resumed = await h.api(token, 'POST', `/api/v1/autopayments/${id}/resume`);
    assert.equal(resumed.status, 200);
    assert.deepEqual([pick(resumed.body, 'status'), pick(resumed.body, 'attempt'), pick(resumed.body, 'failureReason'), pick(resumed.body, 'nextRunOn')], ['ACTIVE', 0, null, '2026-11-21']);
  });

  it('повтор после пополнения счёта: вторая попытка выполняется и счётчик попыток сбрасывается', async () => {
    const { token, from, id } = await annaRent(13_000_000);
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    assert.equal(pick(await autopaymentOf(h, token, id), 'attempt'), 1);
    const opening = await findSystemAccount(h.pool, 'OPENING');
    await postEntries(h.pool, [{ debitAccountId: opening.id, creditAccountId: from.id, amount: 5_000_000n, kind: 'OPENING', description: 'Пополнение счёта' }], { operationId: null, postedAt: h.clock.now() });
    h.setTime(moscow('2026-10-22T10:00:00'));
    await tick(h);
    const runs = await runsOf(h, token, id);
    assert.deepEqual(runs.map((run) => [run.attempt, run.outcome]).reverse(), [[1, 'FAILED'], [2, 'EXECUTED']]);
    const autopayment = await autopaymentOf(h, token, id);
    assert.deepEqual([autopayment.status, autopayment.attempt, autopayment.nextRunOn, autopayment.failureReason], ['ACTIVE', 0, '2026-11-21', null]);
    assert.equal((await accountOf(h, token)).balance, from.balance + 5_000_000 - 13_000_000);
  });

  it('повторная установка тех же часов, возврат часов назад и параллельные циклы не дают второго списания', async () => {
    const { token, from, id } = await annaRent();
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    for (const moment of ['2026-10-21T10:00:00', '2026-10-21T10:00:00', '2026-10-21T15:00:00', '2026-10-21T10:00:00']) {
      h.setTime(moscow(moment));
      await tick(h);
    }
    assert.equal((await runsOf(h, token, id)).length, 1);
    assert.equal((await accountOf(h, token)).balance, from.balance - RENT);

    await h.pool.query("UPDATE autopayments SET next_run_on = '2026-10-21', cycle_on = '2026-10-21', attempt = 0 WHERE id = $1", [id]);
    await assert.rejects(startAttempt(h.deps, id, 'SCHEDULE'), /уже записан/);
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    assert.equal((await runsOf(h, token, id)).length, 1);
    assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 1);
    assert.equal((await accountOf(h, token)).balance, from.balance - RENT);
    assert.equal(autopayEvents(h).length, 1);
  });

  it('падение между записью запуска и переводом: повторная обработка идёт по тому же ключу и создаёт одну операцию', async () => {
    const { token, from, id } = await annaRent();
    h.setTime(moscow('2026-10-21T10:00:00'));
    await Promise.all([h.autopay(), h.autopay(), h.autopay()]);
    await h.drain();
    await Promise.all([h.autopay(), h.autopay()]);
    await h.drain();
    assert.equal((await runsOf(h, token, id)).length, 1);
    assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 1);
    assert.equal((await accountOf(h, token)).balance, from.balance - RENT);
    assert.equal(autopayEvents(h).length, 1);
    assert.equal(pick(await autopaymentOf(h, token, id), 'nextRunOn'), '2026-11-21');
  });

  it('напоминание накануне в 18:00 приходит один раз и только перед обычным платежом, не перед повтором', async () => {
    const { token, id } = await annaRent();
    const loan = await annaRent(13_000_000, 21, {}, 'Кредит');
    h.setTime(moscow('2026-10-20T17:59:00'));
    await tick(h);
    assert.deepEqual(await notificationTexts(h, ANNA, 'AUTOPAYMENT_REMINDER'), []);
    h.setTime(moscow('2026-10-20T18:00:00'));
    await tick(h);
    await tick(h);
    h.setTime(moscow('2026-10-20T23:30:00'));
    await tick(h);
    const reminders = await notificationTexts(h, ANNA, 'AUTOPAYMENT_REMINDER');
    assert.equal(reminders.length, 4);
    assert.match(reminders[0] as string, /завтра, 21 октября, спишется автоплатёж «Аренда»: 25\u00a0000,00\u00a0₽/);
    assert.equal(pick(await autopaymentOf(h, token, id), 'status'), 'ACTIVE');
    const queued = h.events.filter((event) => event.topic === 'bank.notifications' && (event.payload as { kind: string }).kind === 'AUTOPAYMENT_REMINDER');
    assert.equal(queued.length, 4);
    assert.equal((queued[0]?.payload as { operationId: unknown }).operationId, null);
    assert.equal(loadAsyncApi('1.1').payloadValidator('bank.notifications')(queued[0]?.payload).ok, true);

    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    h.setTime(moscow('2026-10-21T18:00:00'));
    await tick(h);
    assert.equal(pick(await autopaymentOf(h, loan.token, loan.id), 'attempt'), 1);
    assert.equal((await notificationTexts(h, ANNA, 'AUTOPAYMENT_REMINDER')).length, 4);
  });

  it('пауза, возобновление, отмена: переходы, отказы 409, пауза не исполняется, шаблон с действующим автоплатежом не удалить', async () => {
    const { token, templateId, id } = await annaRent();
    const call = (action: string, method = 'POST') => h.api(token, method, `/api/v1/autopayments/${id}${action}`);
    const paused = await call('/pause');
    assert.equal(pick(paused.body, 'status'), 'PAUSED');
    assert.equal(pick((await call('/pause')).body, 'code'), 'AUTOPAYMENT_STATE_INVALID');
    assert.equal((await call('/pause')).status, 409);
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    assert.deepEqual(await runsOf(h, token, id), []);

    const inUse = await h.api(token, 'DELETE', `/api/v1/templates/${templateId}`);
    assert.equal(inUse.status, 409);
    assert.equal(pick(inUse.body, 'code'), 'TEMPLATE_IN_USE');

    const resumed = await call('/resume');
    assert.deepEqual([pick(resumed.body, 'status'), pick(resumed.body, 'nextRunOn')], ['ACTIVE', '2026-11-21']);
    assert.equal((await call('/resume')).status, 409);

    const cancelled = await call('', 'DELETE');
    assert.equal(cancelled.status, 200);
    assert.deepEqual([pick(cancelled.body, 'status'), pick(cancelled.body, 'nextRunOn')], ['FINISHED', null]);
    for (const action of ['/pause', '/resume']) assert.equal((await call(action)).status, 409, action);
    assert.equal((await call('', 'DELETE')).status, 409);
    assert.equal(pick(await autopaymentOf(h, token, id), 'status'), 'FINISHED');
    h.setTime(moscow('2026-11-21T10:00:00'));
    await tick(h);
    assert.deepEqual(await runsOf(h, token, id), []);

    assert.equal((await h.api(token, 'DELETE', `/api/v1/templates/${templateId}`)).status, 204);
    const petr = await h.login(PETR);
    for (const [method, action] of [['POST', '/pause'], ['POST', '/resume'], ['DELETE', ''], ['GET', '/runs']] as const) {
      assert.equal((await h.api(petr, method, `/api/v1/autopayments/${id}${action}`)).status, 404, `${method} ${action}`);
    }
    assert.equal((await h.api(token, 'GET', '/api/v1/autopayments/0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b/runs')).status, 404);
  });

  it('дата окончания включительно: последний платёж проходит, после него автоплатёж завершается; прошедшая дата завершает и паузу', async () => {
    const { token, id } = await annaRent(RENT, 21, { endsOn: '2026-11-21' });
    const paused = await annaRent(RENT, 25, { endsOn: '2026-10-26' }, 'Секция');
    await h.api(paused.token, 'POST', `/api/v1/autopayments/${paused.id}/pause`);
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    assert.deepEqual([pick(await autopaymentOf(h, token, id), 'status'), pick(await autopaymentOf(h, token, id), 'nextRunOn')], ['ACTIVE', '2026-11-21']);
    h.setTime(moscow('2026-11-21T10:00:00'));
    await tick(h);
    const last = await autopaymentOf(h, token, id);
    assert.deepEqual([last.status, last.nextRunOn], ['FINISHED', null]);
    assert.equal((await runsOf(h, token, id)).length, 2);
    assert.equal(autopayEvents(h).length, 2);

    h.setTime(moscow('2026-11-27T09:00:00'));
    await tick(h);
    assert.equal(pick(await autopaymentOf(h, paused.token, paused.id), 'status'), 'FINISHED');
  });
});
