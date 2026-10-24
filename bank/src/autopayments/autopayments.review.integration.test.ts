import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { findSystemAccount } from '../accounts/accounts.repository';
import { postEntries } from '../accounts/ledger';
import { createTransfer } from '../payments/transfer.service';
import { templateCommand } from '../templates/template-rules';
import { findClientTemplate } from '../templates/templates.repository';
import { autopayEvents, autopaymentOf, makeAutopayment, makeTemplate, notificationTexts, runsOf, tick } from '../testing/autopay';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { accountOf, moscow, NEW_OPERATIONS, NIGHT_MOSCOW, NOON_MOSCOW, PHONES, useRelease } from '../testing/scenarios';
import { advanceRun, startAttempt } from './autopay-runner';
import { findRun, listDueAutopaymentIds, listPendingRunIds } from './autopayments.repository';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR, GALINA, IP } = PHONES;

describe('автоплатежи: правки после ревью', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
    await useRelease(h, '1.1');
  });

  afterEach(async () => {
    await h.close();
  });

  async function setup(amount: number, day: number, name = 'Кредит', recipient: string = PETR) {
    const token = await h.login(ANNA);
    const from = await accountOf(h, token);
    const templateId = await makeTemplate(h, token, { name, kind: 'PHONE', fromAccount: from.number, recipientPhone: recipient, amount });
    const created = await makeAutopayment(h, token, { templateId, dayOfMonth: day });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { token, from, templateId, id: String(pick(created.body, 'id')) };
  }

  const manual = (token: string, id: string) => h.api(token, 'POST', `/api/v1/sandbox/autopayments/${id}/run`);

  async function topUp(accountId: string, kopecks: bigint): Promise<void> {
    const opening = await findSystemAccount(h.pool, 'OPENING');
    await postEntries(h.pool, [{ debitAccountId: opening.id, creditAccountId: accountId, amount: kopecks, kind: 'OPENING', description: 'Пополнение счёта' }], { operationId: null, postedAt: h.clock.now() });
  }

  it('повтор в середине цикла не теряет дату платежа: после выполнения повтора следующий платёж — через месяц, а не снова тот же день', async () => {
    const { token, from, id } = await setup(13_000_000, 28);
    const first = await manual(token, id);
    assert.deepEqual(['run.attempt', 'run.outcome', 'run.runDate', 'run.cycleDate', 'autopayment.nextRunOn'].map((path) => pick(first.body, path)), [1, 'FAILED', '2026-10-28', '2026-10-28', '2026-10-21']);
    await topUp(from.id, 40_000_000n);
    const second = await manual(token, id);
    assert.deepEqual(['run.attempt', 'run.outcome', 'run.runDate', 'run.cycleDate'].map((path) => pick(second.body, path)), [2, 'PENDING', '2026-10-21', '2026-10-28']);
    await tick(h);
    const state = await autopaymentOf(h, token, id);
    assert.deepEqual([state.status, state.attempt, state.nextRunOn], ['ACTIVE', 0, '2026-11-28']);

    h.setTime(moscow('2026-10-22T12:00:00'));
    const third = await manual(token, id);
    assert.equal(third.status, 200);
    assert.deepEqual(['run.attempt', 'run.cycleDate'].map((path) => pick(third.body, path)), [1, '2026-11-28']);
    const keys = await h.pool.query<{ idempotency_key: string }>('SELECT idempotency_key FROM autopayment_runs ORDER BY cycle_date, attempt');
    assert.deepEqual(keys.rows.map((row) => row.idempotency_key), [`autopay:${id}:2026-10-28:1`, `autopay:${id}:2026-10-28:2`, `autopay:${id}:2026-11-28:1`]);

    h.setTime(moscow('2026-10-28T10:00:00'));
    await tick(h);
    assert.equal((await runsOf(h, token, id)).length, 3);
  });

  it('возобновление в день платежа начинает попытки заново и не сталкивается со старыми запусками; ручной запуск и планировщик работают', async () => {
    const { token, id } = await setup(13_000_000, 21);
    h.setTime(moscow('2026-10-21T09:00:00'));
    assert.equal(pick(await manual(token, id), 'body.run.outcome'), 'FAILED');
    await h.api(token, 'POST', `/api/v1/autopayments/${id}/pause`);
    h.setTime(moscow('2026-10-21T09:30:00'));
    const resumed = await h.api(token, 'POST', `/api/v1/autopayments/${id}/resume`);
    assert.deepEqual([pick(resumed.body, 'status'), pick(resumed.body, 'attempt'), pick(resumed.body, 'nextRunOn')], ['ACTIVE', 0, '2026-10-21']);

    const again = await manual(token, id);
    assert.equal(again.status, 200);
    assert.deepEqual(['run.attempt', 'run.outcome', 'run.cycleDate'].map((path) => pick(again.body, path)), [1, 'FAILED', '2026-10-21']);
    await h.api(token, 'POST', `/api/v1/autopayments/${id}/pause`);
    await h.api(token, 'POST', `/api/v1/autopayments/${id}/resume`);
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    const runs = await runsOf(h, token, id);
    assert.equal(runs.length, 3);
    assert.deepEqual(runs.map((run) => run.attempt), [1, 1, 1]);
    const keys = await h.pool.query<{ idempotency_key: string }>('SELECT idempotency_key FROM autopayment_runs ORDER BY started_at');
    assert.deepEqual(keys.rows.map((row) => row.idempotency_key), [`autopay:${id}:2026-10-21:1`, `autopay:${id}:2026-10-21:1:s2`, `autopay:${id}:2026-10-21:1:s3`]);
  });

  it('подавленная вставка запуска — явная ошибка, а не молчаливый пропуск; цикл планировщика продолжает работу', async () => {
    const stuck = await setup(2_000_000, 21);
    const other = await setup(2_000_000, 21, 'Другой');
    await h.pool.query("UPDATE autopayments SET next_run_on = '2026-10-21', cycle_on = '2026-10-21' WHERE id = $1", [stuck.id]);
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    await h.pool.query("UPDATE autopayments SET next_run_on = '2026-10-21', cycle_on = '2026-10-21', attempt = 0, status = 'ACTIVE' WHERE id = $1", [stuck.id]);
    await assert.rejects(startAttempt(h.deps, stuck.id, 'MANUAL'), /уже записан/);
    const response = await manual(stuck.token, stuck.id);
    assert.equal(response.status, 500);
    assert.equal(pick((await runsOf(h, other.token, other.id))[0], 'outcome'), 'EXECUTED');
  });

  it('перевод создан, а привязать его к запуску не успели, шаблон тем временем изменили: запуск подхватывает ту же операцию, второго списания нет', async () => {
    const { token, from, templateId, id } = await setup(2_000_000, 21);
    h.setTime(moscow('2026-10-21T10:00:00'));
    const runId = (await startAttempt(h.deps, id, 'SCHEDULE')) as string;
    const run = (await findRun(h.pool, runId)) as NonNullable<Awaited<ReturnType<typeof findRun>>>;
    const client = await h.pool.query<{ id: string }>('SELECT id FROM clients WHERE phone = $1', [ANNA]);
    const template = (await findClientTemplate(h.pool, (client.rows[0] as { id: string }).id, templateId)) as NonNullable<Awaited<ReturnType<typeof findClientTemplate>>>;
    const created = await createTransfer(h.deps, {
      clientId: (client.rows[0] as { id: string }).id,
      idempotencyKey: run.idempotencyKey,
      command: templateCommand(template, run.amount, template.comment),
      templateId,
      requestId: 'crash-before-attach',
      attemptLabel: null,
    });
    await h.api(token, 'PATCH', `/api/v1/templates/${templateId}`, { comment: 'Теперь с сообщением' });
    await tick(h);
    const [settled] = await runsOf(h, token, id);
    assert.deepEqual([settled?.outcome, settled?.operationId, settled?.reasonCode], ['EXECUTED', created.operationId, null]);
    assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 1);
    assert.equal((await accountOf(h, token)).balance, from.balance - 2_000_000);
    assert.equal(autopayEvents(h).length, 1);
  });

  it('отмена автоплатежа с висящим запуском: перевод не создаётся, запуск закрыт без повтора, текст без предложения возобновить', async () => {
    const { token, from, id } = await setup(2_000_000, 21);
    h.setTime(moscow('2026-10-21T10:00:00'));
    const runId = (await startAttempt(h.deps, id, 'SCHEDULE')) as string;
    assert.equal((await h.api(token, 'DELETE', `/api/v1/autopayments/${id}`)).status, 200);
    await tick(h);
    const run = await findRun(h.pool, runId);
    assert.deepEqual([run?.outcome, run?.reasonCode, run?.operationId], ['FAILED', 'AUTOPAYMENT_CANCELLED', null]);
    assert.equal((await h.pool.query(NEW_OPERATIONS)).rowCount, 0);
    assert.equal((await accountOf(h, token)).balance, from.balance);
    const state = await autopaymentOf(h, token, id);
    assert.deepEqual([state.status, state.nextRunOn], ['FINISHED', null]);
    const texts = await notificationTexts(h, ANNA, 'AUTOPAYMENT_FAILED');
    assert.match(texts[0] as string, /автоплатёж отменён\. Автоплатёж завершён, повторов не будет\./);
    assert.equal(texts.some((text) => /возобнов/i.test(text)), false);
    assert.deepEqual(autopayEvents(h).map((event) => [event.payload.outcome, event.payload.reasonCode, event.payload.operationId]), [['FAILED', 'AUTOPAYMENT_CANCELLED', null]]);
  });

  it('пауза с висящим запуском: перевод не создаётся, автоплатёж остаётся на паузе и после возобновления работает', async () => {
    const { token, from, id } = await setup(2_000_000, 21);
    h.setTime(moscow('2026-10-21T10:00:00'));
    const runId = (await startAttempt(h.deps, id, 'SCHEDULE')) as string;
    await h.api(token, 'POST', `/api/v1/autopayments/${id}/pause`);
    await tick(h);
    assert.deepEqual([(await findRun(h.pool, runId))?.reasonCode, pick(await autopaymentOf(h, token, id), 'status')], ['AUTOPAYMENT_PAUSED', 'PAUSED']);
    assert.equal((await accountOf(h, token)).balance, from.balance);
    assert.match((await notificationTexts(h, ANNA, 'AUTOPAYMENT_FAILED'))[0] as string, /Автоплатёж на паузе: возобновить его можно в интернет-банке\./);
    assert.equal(pick(await h.api(token, 'POST', `/api/v1/autopayments/${id}/resume`), 'body.status'), 'ACTIVE');
    assert.equal(pick(await manual(token, id), 'body.run.outcome'), 'PENDING');
  });

  it('удалённый шаблон при исполнении: запуск закрывается без перевода', async () => {
    const { token, from, templateId, id } = await setup(2_000_000, 21);
    h.setTime(moscow('2026-10-21T10:00:00'));
    const runId = (await startAttempt(h.deps, id, 'SCHEDULE')) as string;
    await h.pool.query('UPDATE transfer_templates SET deleted_at = now() WHERE id = $1', [templateId]);
    await tick(h);
    assert.deepEqual([(await findRun(h.pool, runId))?.reasonCode, (await findRun(h.pool, runId))?.operationId], ['TEMPLATE_NOT_FOUND', null]);
    assert.equal((await accountOf(h, token)).balance, from.balance);
  });

  it('создание автоплатежа и удаление шаблона не разъезжаются: действующего автоплатежа на удалённом шаблоне не бывает', async () => {
    const token = await h.login(ANNA);
    const from = await accountOf(h, token);
    for (let round = 0; round < 6; round += 1) {
      const templateId = await makeTemplate(h, token, { name: `Гонка ${round}`, kind: 'PHONE', fromAccount: from.number, recipientPhone: PETR, amount: 100_000 });
      const [created, removed] = await Promise.all([
        makeAutopayment(h, token, { templateId, dayOfMonth: 5 }),
        h.api(token, 'DELETE', `/api/v1/templates/${templateId}`),
      ]);
      assert.equal(created.status === 201 && removed.status === 204, false, `раунд ${round}`);
      assert.ok([201, 404].includes(created.status));
      assert.ok([204, 409].includes(removed.status));
    }
    const broken = await h.pool.query(
      "SELECT 1 FROM autopayments a JOIN transfer_templates t ON t.id = a.template_id WHERE t.deleted_at IS NOT NULL AND a.status <> 'FINISHED'",
    );
    assert.equal(broken.rowCount, 0);
  });

  it('запуски на ручной проверке не загораживают очередь: в выборку попадают только те, что можно продвинуть, и только автоплатежи без висящего запуска', async () => {
    h.setTime(NIGHT_MOSCOW);
    const stuck = [];
    for (const [index, phone] of [PETR, GALINA, IP].entries()) stuck.push(await setup(2_000_000, 21, `Ночной ${index}`, phone));
    const fresh = await setup(13_000_000, 21, 'Свежий');
    h.setTime(moscow('2026-10-21T23:10:00'));
    for (const item of stuck) {
      const runId = (await startAttempt(h.deps, item.id, 'MANUAL')) as string;
      await advanceRun(h.deps, runId, { requestId: 'stuck-run', attemptLabel: null });
    }
    await h.drain();
    for (const item of stuck) assert.equal(pick(await manual(item.token, item.id), 'body.code'), 'AUTOPAYMENT_STATE_INVALID');
    assert.deepEqual(await listPendingRunIds(h.pool, 2), []);
    const due = await listDueAutopaymentIds(h.pool, '2026-10-21', 1);
    assert.deepEqual(due, [fresh.id]);
    const freshRun = (await startAttempt(h.deps, fresh.id, 'SCHEDULE')) as string;
    assert.deepEqual(await listPendingRunIds(h.pool, 2), [freshRun]);
  });
});
