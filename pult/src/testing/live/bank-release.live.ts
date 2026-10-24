import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, it } from 'node:test';
import { READINESS } from '../../modules/readiness';
import { collectObservations } from '../../probes/run';
import { eventually, liveSuite, type LiveEnv } from './support';

type Facts = Record<string, any>;

const ANNA = '+79001110001';
const PETR = '+79001110002';
const ACCOUNT_ANNA = '40817810800000001000';
const TOPIC = 'bank.autopayments.executed';
const FINAL = new Set(['COMPLETED', 'REJECTED', 'FAILED', 'REFUNDED']);

let counter = 0;
const key = () => `live-rel-${Date.now()}-${(counter += 1)}`;

const EVENTS_SCHEMA = (operationId: string) => `asyncapi: '2.6.0'
info:
  title: События
  version: 1.0.0
channels:
  ${TOPIC}:
    subscribe:
      message:
        name: AutopaymentExecuted
        payload:
          type: object
          required: [autopaymentId, outcome, operationId, reasonCode]
          properties:
            autopaymentId:
              type: string
            outcome:
              type: string
              enum: [EXECUTED, FAILED]
            operationId:
              ${operationId}
            reasonCode:
              type: [string, 'null']
`;

async function settled(env: LiveEnv, id: string) {
  return eventually(
    () => env.probe<Facts>('bank.operation', { id }),
    (value) => value.exists === true && FINAL.has(value.status),
    20_000,
    400,
  );
}

liveSuite('bank', READINESS.bank ?? [], 'ЗапускБанк 1.1: шаблоны, автоплатежи и производные факты на живом банке', (env) => {
  const { probe } = env;

  before(() => {
    writeFileSync(join(env.dataDir(), 'bank-secret'), `${process.env.KIT_LIVE_BANK_SECRET ?? ''}\n`);
  });

  const scenario = (params: Record<string, unknown>) => probe('bank.scenario', { reset: true, bankTime: 'noon', ...params });
  const http = (method: string, path: string, body?: Record<string, unknown>, headers?: Record<string, string>, asPhone = ANNA) =>
    probe<Facts>('bank.http', { asPhone, method, path, ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });
  const template = (body: Record<string, unknown> = {}, asPhone = ANNA) =>
    http('POST', '/api/v1/templates', { name: `Шаблон-${key()}`, kind: 'PHONE', fromAccount: ACCOUNT_ANNA, recipientPhone: PETR, amount: 100_000, ...body }, undefined, asPhone);

  it('до релиза 1.1 факты автоплатежей недоступны с понятной ошибкой, на 1.1 — доступны', async () => {
    await scenario({ defects: [], release: '1.0' });
    await assert.rejects(probe('bank.autopayments', { phone: ANNA }), /доступны с релиза 1\.1/);
    await scenario({ defects: [], release: '1.1' });
    const facts = await probe<Facts>('bank.autopayments', { phone: ANNA });
    assert.deepEqual([facts.count, facts.templatesCount, facts.runsCount, facts.runs], [0, 0, 0, []]);
  });

  it('шаблон из операции и перевод по шаблону: byTemplate, templateId, журнал запросов с маршрутом и классом ответа', async () => {
    await scenario({ defects: [], release: '1.1' });
    const plain = await http('POST', '/api/v1/transfers', { type: 'PHONE_TRANSFER', fromAccount: ACCOUNT_ANNA, recipientPhone: PETR, amount: 100_000 }, { 'Idempotency-Key': key() });
    await settled(env, plain.id);
    const created = await http('POST', '/api/v1/templates', { name: 'Маме', fromOperationId: plain.id });
    assert.equal(created.status, 201);
    const taken = await http('POST', '/api/v1/templates', { name: 'маме', fromOperationId: plain.id });
    assert.deepEqual([taken.status, taken.code], [409, 'TEMPLATE_NAME_TAKEN']);
    const byTemplate = await http('POST', `/api/v1/templates/${created.id}/transfers`, { amount: 250_000 }, { 'Idempotency-Key': key() });
    assert.equal(byTemplate.status, 201);
    await settled(env, byTemplate.id);
    const operations = await probe<Facts>('bank.operations', { label: env.label, phone: ANNA });
    const flags = Object.fromEntries(operations.operations.map((item: Facts) => [item.amountKop, item.byTemplate]));
    assert.deepEqual(flags, { 100_000: false, 250_000: true });
    const log = await probe<Facts>('bank.requestLog', { label: env.label });
    const find = (method: string, route: string, extra: Record<string, unknown> = {}) =>
      log.requests.find((item: Facts) => item.method === method && item.route === route && Object.entries(extra).every(([field, value]) => item[field] === value));
    assert.ok(find('POST', '/api/v1/templates', { statusClass: '2xx' }));
    assert.ok(find('POST', '/api/v1/templates', { status: 409, statusClass: '4xx' }));
    assert.ok(find('POST', '/api/v1/templates/{id}/transfers', { statusClass: '2xx' }));
  });

  it('автоплатёж без денег: запуск с причиной и пометкой сбоя, событие в Kafka проходит описание и не проходит, если поле без null', async () => {
    await scenario({ defects: ['autopay-no-retry'], release: '1.1' });
    const tpl = await template({ amount: undefined });
    const autopayment = await http('POST', '/api/v1/autopayments', { templateId: tpl.id, dayOfMonth: 15, amount: 13_000_000 });
    assert.equal(autopayment.status, 201);
    const run = await probe<Facts>('bank.autopayRun', { autopaymentId: autopayment.id });
    assert.deepEqual([run.outcome, run.reasonCode, run.attempt, run.autopaymentStatus, run.nextRunOn], ['FAILED', 'INSUFFICIENT_FUNDS', 1, 'FAILED', '']);
    const facts = await probe<Facts>('bank.autopayments', { phone: ANNA });
    assert.deepEqual([facts.failedRuns, facts.executedRuns], [1, 0]);
    assert.equal(facts.runs.length, 1);
    assert.equal(facts.runs[0].autopaymentId, autopayment.id);
    assert.deepEqual(facts.runs[0].defectCodes, ['autopay-no-retry']);
    assert.equal(facts.runs[0].operationId, null);

    const events = await eventually(
      () => probe<Facts>('kafka.messages', { topic: TOPIC, limit: 50 }),
      (value) => value.count >= 1,
      15_000,
    );
    assert.equal(events.messages[0].value.outcome, 'FAILED');
    assert.equal(events.messages[0].value.operationId, null);
    env.write('events.asyncapi.yaml', EVENTS_SCHEMA("type: [string, 'null']"));
    env.write('events-strict.asyncapi.yaml', EVENTS_SCHEMA('type: string'));
    const observed = await collectObservations(
      [
        { id: 'events', probe: 'kafka.messages', params: { topic: TOPIC, limit: 50 } },
        { id: 'ok', probe: 'asyncapi.samples', params: { file: 'events.asyncapi.yaml', channel: TOPIC, samplesFrom: { probe: 'events', path: 'messages[].value' } } },
        { id: 'strict', probe: 'asyncapi.samples', params: { file: 'events-strict.asyncapi.yaml', channel: TOPIC, samplesFrom: { probe: 'events', path: 'messages[].value' } } },
      ],
      env.context(),
    );
    assert.equal((observed.ok as Facts).allOk, true);
    assert.equal((observed.strict as Facts).allOk, false);
    assert.match((observed.strict as Facts).results[0].errors.join(' '), /operationId/);
  });

  it('без дефекта нехватка денег не даёт пометки и автоплатёж ждёт повтор; сбой включается и выключается сценарием', async () => {
    await scenario({ defects: [], release: '1.1' });
    const tpl = await template({ amount: undefined });
    const autopayment = await http('POST', '/api/v1/autopayments', { templateId: tpl.id, dayOfMonth: 16, amount: 13_000_000 });
    const run = await probe<Facts>('bank.autopayRun', { autopaymentId: autopayment.id });
    assert.deepEqual([run.outcome, run.reasonCode, run.autopaymentStatus], ['FAILED', 'INSUFFICIENT_FUNDS', 'ACTIVE']);
    assert.notEqual(run.nextRunOn, '');
    const facts = await probe<Facts>('bank.autopayments', { autopaymentId: autopayment.id });
    assert.deepEqual(facts.runs[0].defectCodes, []);
  });

  it('сбои шаблона: перевод по шаблону сверх лимита и с другой суммой проходит с пометкой, без сбоев — отказ по лимиту и сумма запроса', async () => {
    const GALINA = '+79001110003';
    const GALINA_ACCOUNT = '40817810000000001004';
    const overLimit = async () => {
      const tpl = await template({ fromAccount: GALINA_ACCOUNT, recipientPhone: ANNA, amount: 6_000_000 }, GALINA);
      const created = await http('POST', `/api/v1/templates/${tpl.id}/transfers`, {}, { 'Idempotency-Key': key() }, GALINA);
      return settled(env, created.id);
    };
    await scenario({ defects: ['template-skips-limit'], release: '1.1' });
    const skipped = await overLimit();
    assert.deepEqual([skipped.status, skipped.defects.map((item: Facts) => item.code)], ['COMPLETED', ['template-skips-limit']]);
    await scenario({ defects: [], release: '1.1' });
    const rejected = await overLimit();
    assert.deepEqual([rejected.status, rejected.reasonCode, rejected.defects], ['REJECTED', 'DAILY_LIMIT_EXCEEDED', []]);

    const withAmount = async () => {
      const tpl = await template({ amount: 100_000 });
      const created = await http('POST', `/api/v1/templates/${tpl.id}/transfers`, { amount: 250_000 }, { 'Idempotency-Key': key() });
      return settled(env, created.id);
    };
    await scenario({ defects: ['template-ignores-amount'], release: '1.1' });
    const ignored = await withAmount();
    assert.deepEqual([ignored.amountKop, ignored.defects.map((item: Facts) => item.code)], [100_000, ['template-ignores-amount']]);
    await scenario({ defects: [], release: '1.1' });
    assert.equal((await withAmount()).amountKop, 250_000);
  });

  it('перевод по шаблону ночью новому получателю уходит на ручную проверку, как обычный перевод', async () => {
    await scenario({ defects: [], release: '1.1', bankTime: 'night+30m' });
    const tpl = await template({ recipientPhone: '+79001110003', amount: 10_000_000 });
    const created = await http('POST', `/api/v1/templates/${tpl.id}/transfers`, {}, { 'Idempotency-Key': key() });
    const onReview = await eventually(
      () => probe<Facts>('bank.operation', { id: created.id }),
      (value) => value.exists === true && value.status === 'ON_REVIEW',
      20_000,
      400,
    );
    assert.equal(onReview.status, 'ON_REVIEW');
    assert.equal(typeof onReview.antifraudScore, 'number');
    const flagged = await probe<Facts>('bank.operations', { label: env.label, phone: ANNA });
    assert.deepEqual([flagged.operations[0].wasOnReview, flagged.operations[0].byTemplate], [true, true]);
  });

  it('автоплатёж с деньгами исполняется, запуск ждёт конечного статуса операции', async () => {
    await scenario({ defects: [], release: '1.1' });
    const tpl = await template();
    const autopayment = await http('POST', '/api/v1/autopayments', { templateId: tpl.id, dayOfMonth: 17 });
    await probe('bank.autopayRun', { autopaymentId: autopayment.id });
    const facts = await eventually(
      () => probe<Facts>('bank.autopayments', { phone: ANNA }),
      (value) => value.executedRuns >= 1,
      20_000,
      500,
    );
    assert.deepEqual([facts.executedRuns, facts.failedRuns, facts.pendingRuns], [1, 0, 0]);
    assert.ok(facts.runs[0].operationNumber);
  });
});
