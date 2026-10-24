import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { autopayEvents, autopaymentOf, makeAutopayment, makeTemplate, runsOf, tick } from '../testing/autopay';
import { KIT_TEST_SECRET, pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, moscow, NOON_MOSCOW, PHONES, phoneTransfer, settledTransfer, useRelease } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const NORTHWIND_PHONE = '+79000000021';

describe('автоплатежи проходят те же правила, что обычный перевод', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW, { kitSecret: KIT_TEST_SECRET });
    await useRelease(h, '1.1');
  });

  afterEach(async () => {
    await h.close();
  });

  async function setup(phone: string, recipient: string, amount: number, extra: Record<string, unknown> = {}, day = 21) {
    const token = await h.login(phone);
    const from = await accountOf(h, token);
    const templateId = await makeTemplate(h, token, { name: 'Платёж', kind: 'PHONE', fromAccount: from.number, recipientPhone: recipient, amount, ...extra });
    const created = await makeAutopayment(h, token, { templateId, dayOfMonth: day });
    assert.equal(created.status, 201);
    return { token, from, id: String(pick(created.body, 'id')), templateId };
  }

  const stateOf = async (token: string, id: string) => {
    const autopayment = await autopaymentOf(h, token, id);
    return [autopayment.status, autopayment.attempt, autopayment.failureReason, autopayment.nextRunOn];
  };

  it('суточный лимит: перевод отклонён с операцией REJECTED, это нехватка лимита — повтор на следующий день и выполнение', async () => {
    const { token, from, id, templateId } = await setup(PETR, ANNA, 6_000_000);
    h.setTime(moscow('2026-10-21T09:30:00'));
    const plain = await settledTransfer(h, token, 'rules-limit-0001', phoneTransfer(from.number, ANNA, 10_000_000));
    assert.equal(pick(plain.body, 'status'), 'COMPLETED');
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    assert.deepEqual(await stateOf(token, id), ['ACTIVE', 1, 'DAILY_LIMIT_EXCEEDED', '2026-10-22']);
    const [rejected] = await runsOf(h, token, id);
    assert.deepEqual([rejected?.outcome, rejected?.reasonCode], ['FAILED', 'DAILY_LIMIT_EXCEEDED']);
    const operation = await h.api(token, 'GET', `/api/v1/operations/${String(rejected?.operationId)}`);
    assert.deepEqual([pick(operation.body, 'status'), pick(operation.body, 'rejection.code'), pick(operation.body, 'templateId')], ['REJECTED', 'DAILY_LIMIT_EXCEEDED', templateId]);
    assert.equal((await accountOf(h, token)).balance, from.balance - 10_000_000);

    h.setTime(moscow('2026-10-22T10:00:00'));
    await tick(h);
    assert.deepEqual(await stateOf(token, id), ['ACTIVE', 0, null, '2026-11-21']);
    assert.equal((await accountOf(h, token)).balance, from.balance - 10_000_000 - 6_000_000);
    assert.deepEqual(autopayEvents(h).map((event) => [event.payload.attempt, event.payload.outcome, event.payload.reasonCode]), [[1, 'FAILED', 'DAILY_LIMIT_EXCEEDED'], [2, 'EXECUTED', null]]);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('комиссия: перевод в другой банк по автоплатежу берёт комиссию тарифа', async () => {
    const made = await h.kit('POST', '/_kit/actions/check-client', { tariffCode: 'START', balanceKop: 50_000_000 });
    const token = await h.login(String(pick(made.body, 'phone')));
    const number = String(pick(made.body, 'accountNumber'));
    const templateId = await makeTemplate(h, token, { name: 'Иван', kind: 'SBP', fromAccount: number, recipientPhone: NORTHWIND_PHONE, recipientBankCode: 'NORTHWIND', amount: 13_000_000 });
    const id = String(pick((await makeAutopayment(h, token, { templateId, dayOfMonth: 21 })).body, 'id'));
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    const [run] = await runsOf(h, token, id);
    assert.equal(run?.outcome, 'EXECUTED');
    const operation = await h.api(token, 'GET', `/api/v1/operations/${String(run?.operationId)}`);
    assert.deepEqual([pick(operation.body, 'route'), pick(operation.body, 'fee'), pick(operation.body, 'status')], ['SBP', 30_000, 'COMPLETED']);
    assert.equal((await accountOf(h, token)).balance, 50_000_000 - 13_000_000 - 30_000);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('антифрод и ручная проверка: ночной платёж ждёт оператора, запуск в ожидании; одобрение завершает его, отклонение останавливает автоплатёж без повторов', async () => {
    const approve = await setup(ANNA, PETR, 2_000_000);
    const reject = await setup(ANNA, PHONES.GALINA, 6_000_000, { name: 'Другой' });
    h.setTime(moscow('2026-10-21T23:10:00'));
    await tick(h);
    for (const { token, id } of [approve, reject]) {
      assert.equal(pick((await runsOf(h, token, id))[0], 'outcome'), 'PENDING');
      assert.deepEqual(await stateOf(token, id), ['ACTIVE', 0, null, '2026-10-21']);
    }
    assert.equal(autopayEvents(h).length, 0);
    await tick(h);
    assert.equal((await runsOf(h, approve.token, approve.id)).length, 1);

    const operator = await h.operatorLogin();
    const operationOf = async (token: string, id: string) => String(pick((await runsOf(h, token, id))[0], 'operationId'));
    assert.equal(pick(await h.api(approve.token, 'GET', `/api/v1/operations/${await operationOf(approve.token, approve.id)}`), 'body.status'), 'ON_REVIEW');
    await h.api(operator, 'POST', `/api/v1/office/reviews/${await operationOf(approve.token, approve.id)}/approve`, { comment: 'Клиент подтвердил' });
    await h.api(operator, 'POST', `/api/v1/office/reviews/${await operationOf(reject.token, reject.id)}/reject`, { comment: 'Подозрительный получатель' });
    await tick(h);

    assert.deepEqual(await stateOf(approve.token, approve.id), ['ACTIVE', 0, null, '2026-11-21']);
    assert.deepEqual(await stateOf(reject.token, reject.id), ['FAILED', 1, 'OPERATOR_REJECTED', null]);
    assert.deepEqual(autopayEvents(h).map((event) => [event.payload.outcome, event.payload.reasonCode]).sort(), [['EXECUTED', null], ['FAILED', 'OPERATOR_REJECTED']]);
    h.setTime(moscow('2026-10-22T10:00:00'));
    await tick(h);
    assert.equal((await runsOf(h, reject.token, reject.id)).length, 1);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('антифрод отклонил перевод — это не нехватка денег: автоплатёж сразу FAILED, без повторов', async () => {
    const { token, id } = await setup(ANNA, PETR, 2_000_000);
    await h.pool.query('UPDATE antifraud_settings SET review_threshold = 10, reject_threshold = 40 WHERE id = 1');
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    assert.deepEqual(await stateOf(token, id), ['FAILED', 1, 'ANTIFRAUD_REJECTED', null]);
    h.setTime(moscow('2026-10-22T10:00:00'));
    await tick(h);
    assert.equal((await runsOf(h, token, id)).length, 1);
    assert.equal(autopayEvents(h)[0]?.payload.reasonCode, 'ANTIFRAUD_REJECTED');
  });

  it('арест счёта и блокировка клиента: автоплатёж сразу FAILED с причиной, без повторов', async () => {
    const arrested = await setup(ANNA, PHONES.GALINA, 2_000_000);
    const blocked = await setup(PETR, ANNA, 2_000_000);
    await h.pool.query("UPDATE accounts SET status = 'ARRESTED' WHERE number = $1", [arrested.from.number]);
    await h.pool.query("UPDATE clients SET status = 'BLOCKED' WHERE phone = $1", [PETR]);
    h.setTime(moscow('2026-10-21T10:00:00'));
    await tick(h);
    assert.deepEqual(await stateOf(arrested.token, arrested.id), ['FAILED', 1, 'ACCOUNT_ARRESTED', null]);
    const fresh = await accountOf(h, arrested.token);
    assert.equal(fresh.balance, arrested.from.balance);
    const clientRow = await h.pool.query('SELECT status, failure_code FROM autopayments WHERE id = $1', [blocked.id]);
    assert.deepEqual([clientRow.rows[0].status, clientRow.rows[0].failure_code], ['FAILED', 'CLIENT_BLOCKED']);
    h.setTime(moscow('2026-10-22T10:00:00'));
    await tick(h);
    assert.equal(autopayEvents(h).length, 2);
  });

  it('ручной запуск в тестовом контуре: попытка по тем же правилам и с записью запуска; пока запуск не завершён, второй отвергается; после выполнения — следующий платёж', async () => {
    const { token, id } = await setup(ANNA, PETR, 2_000_000, {}, 25);
    const run = (autopaymentId: string, as: string | null = token) => h.api(as, 'POST', `/api/v1/sandbox/autopayments/${autopaymentId}/run`);
    const first = await run(id);
    assert.equal(first.status, 200);
    assert.deepEqual(['run.attempt', 'run.outcome', 'run.runDate', 'autopayment.status'].map((path) => pick(first.body, path)), [1, 'PENDING', '2026-10-25', 'ACTIVE']);
    assert.equal(pick(first.body, 'run.autopaymentId'), id);
    assert.equal(pick((await run(id)).body, 'code'), 'AUTOPAYMENT_STATE_INVALID');
    await tick(h);
    assert.deepEqual(await stateOf(token, id), ['ACTIVE', 0, null, '2026-11-25']);
    assert.equal(pick((await runsOf(h, token, id))[0], 'outcome'), 'EXECUTED');

    const second = await run(id);
    assert.equal(pick(second.body, 'run.runDate'), '2026-11-25');
    assert.equal(pick(second.body, 'run.attempt'), 1);
    await tick(h);
    assert.equal((await runsOf(h, token, id)).length, 2);
    assert.equal(autopayEvents(h).length, 2);

    assert.equal((await run(id, null)).status, 401);
    assert.equal((await run(id, await h.login(PETR))).status, 404);
    assert.equal((await run('не-uuid')).status, 400);
    await h.api(token, 'POST', `/api/v1/autopayments/${id}/pause`);
    assert.equal((await run(id)).status, 409);
  });

  it('ручной запуск без денег: три неудачи подряд останавливают автоплатёж, четвёртый запуск отвергается', async () => {
    const { token, id } = await setup(ANNA, PETR, 13_000_000, {}, 25);
    const outcomes: unknown[] = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await h.api(token, 'POST', `/api/v1/sandbox/autopayments/${id}/run`);
      assert.equal(response.status, 200);
      outcomes.push([pick(response.body, 'run.attempt'), pick(response.body, 'run.outcome'), pick(response.body, 'run.reasonCode'), pick(response.body, 'autopayment.status')]);
    }
    assert.deepEqual(outcomes, [
      [1, 'FAILED', 'INSUFFICIENT_FUNDS', 'ACTIVE'],
      [2, 'FAILED', 'INSUFFICIENT_FUNDS', 'ACTIVE'],
      [3, 'FAILED', 'INSUFFICIENT_FUNDS', 'FAILED'],
    ]);
    assert.equal((await h.api(token, 'POST', `/api/v1/sandbox/autopayments/${id}/run`)).status, 409);
    await h.drain();
    assert.equal(autopayEvents(h).length, 3);
  });

  it('служебный API набора: ручной запуск, факты шаблонов и автоплатежей, templateId в фактах операций', async () => {
    const { token, id, templateId } = await setup(ANNA, PETR, 2_000_000, {}, 25);
    const run = await h.kit('POST', '/_kit/actions/autopay-run', { autopaymentId: id, label: 'kit-run-1' });
    assert.equal(run.status, 200);
    assert.deepEqual(['attempt', 'outcome', 'autopaymentStatus', 'nextRunOn'].map((field) => pick(run.body, field)), [1, 'PENDING', 'ACTIVE', '2026-10-25']);
    await tick(h);
    const facts = await h.kit('GET', `/_kit/facts/autopayments?phone=${encodeURIComponent(ANNA)}`);
    assert.equal(facts.status, 200);
    assert.deepEqual((pick(facts.body, 'templates') as { id: string; amountKop: number; clientPhone: string }[]).map((item) => [item.id, item.amountKop, item.clientPhone]), [[templateId, 2_000_000, ANNA]]);
    const [autopayment] = pick(facts.body, 'autopayments') as { id: string; status: string; nextRunOn: string; runs: { outcome: string; attempt: number }[] }[];
    assert.deepEqual([autopayment?.id, autopayment?.status, autopayment?.nextRunOn, autopayment?.runs.map((item) => [item.attempt, item.outcome])], [id, 'ACTIVE', '2026-11-25', [[1, 'EXECUTED']]]);
    const operations = await h.kit('GET', `/_kit/facts/operations?phone=${encodeURIComponent(ANNA)}&label=kit-run-1`);
    assert.equal(pick(operations.body, '0.templateId'), templateId);
    assert.equal((await h.kit('POST', '/_kit/actions/autopay-run', { autopaymentId: '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b', label: 'kit-run-2' })).status, 404);
    assert.equal((await h.kit('POST', '/_kit/actions/autopay-run', { autopaymentId: 'x', label: 'kit-run-2' })).status, 400);
    assert.equal((await h.kit('GET', '/_kit/facts/autopayments', undefined, null)).status, 404);
    assert.equal(token.length > 0, true);
  });

  it('офис видит автоплатежи клиента вместе с запусками, только для чтения', async () => {
    const { id } = await setup(ANNA, PETR, 13_000_000, {}, 25);
    const token = await h.login(ANNA);
    await h.api(token, 'POST', `/api/v1/sandbox/autopayments/${id}/run`);
    const operator = await h.operatorLogin();
    const client = await h.pool.query<{ id: string }>('SELECT id FROM clients WHERE phone = $1', [ANNA]);
    const clientId = (client.rows[0] as { id: string }).id;
    const response = await h.api(operator, 'GET', `/api/v1/office/clients/${clientId}/autopayments`);
    assert.equal(response.status, 200);
    assert.deepEqual([pick(response.body, 'items.0.autopayment.id'), pick(response.body, 'items.0.runs.0.reasonCode'), pick(response.body, 'items.0.autopayment.attempt')], [id, 'INSUFFICIENT_FUNDS', 1]);
    assert.equal((await h.api(token, 'GET', `/api/v1/office/clients/${clientId}/autopayments`)).status, 401);
    assert.equal((await h.api(operator, 'POST', `/api/v1/office/clients/${clientId}/autopayments`, {})).status, 404);
  });

  it('сброс стирает шаблоны и автоплатежи и возвращает релиз 1.0', async () => {
    const { token } = await setup(ANNA, PETR, 2_000_000);
    assert.equal((await h.kit('POST', '/_kit/reset')).status, 200);
    for (const table of ['transfer_templates', 'autopayments', 'autopayment_runs']) {
      assert.equal(((await h.pool.query(`SELECT COUNT(*) AS total FROM ${table}`)).rows[0] as { total: bigint }).total, 0n, table);
    }
    assert.equal(token.length > 0, true);
    assert.equal((await fetch(`${h.baseUrl}/health`).then((response) => response.json()) as { release: string }).release, '1.0');
  });
});
