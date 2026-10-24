import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, it } from 'node:test';
import { Kafka, logLevel } from 'kafkajs';
import { READINESS } from '../../modules/readiness';
import { collectObservations } from '../../probes/run';
import { eventually, liveSuite } from './support';

type Facts = Record<string, any>;

const ANNA = '+79001110001';
const PETR = '+79001110002';
const GALINA = '+79001110003';
const ACCOUNT_ANNA = '40817810800000001000';
const FINAL = new Set(['COMPLETED', 'REJECTED', 'FAILED', 'REFUNDED']);
const NOTIFICATION_DEFINITIONS = {
  queues: [{ name: 'mobile-notifications', vhost: '/', durable: true, auto_delete: false, arguments: {} }],
  bindings: [
    { source: 'bank.notifications', vhost: '/', destination: 'mobile-notifications', destination_type: 'queue', routing_key: 'notification', arguments: {} },
  ],
};

let counter = 0;
const key = () => `live-task-${Date.now()}-${(counter += 1)}`;

liveSuite('bank', READINESS.bank ?? [], 'ЗапускБанк: проверки и сценарии для тикетов', (env) => {
  const { probe } = env;

  before(async () => {
    writeFileSync(join(env.dataDir(), 'bank-secret'), `${process.env.KIT_LIVE_BANK_SECRET ?? ''}\n`);
    await probe('bank.scenario', { reset: true, defects: [], bankTime: 'noon' });
  });

  const scenario = (params: Record<string, unknown>) => probe('bank.scenario', { reset: true, bankTime: 'noon', ...params });
  const send = (asPhone: string, amount: number, recipientPhone: string, extra: Record<string, unknown> = {}) =>
    probe<Facts>('bank.http', {
      asPhone,
      method: 'POST',
      path: '/api/v1/transfers',
      body: { type: 'PHONE_TRANSFER', fromAccount: ACCOUNT_ANNA, recipientPhone, amount, ...extra },
      headers: { 'Idempotency-Key': key() },
    });
  const settled = (id: string, done: (status: string) => boolean = (status) => FINAL.has(status)) =>
    eventually(() => probe<Facts>('bank.operation', { id }), (value) => value.exists === true && done(value.status), 30_000, 400);

  it('пополнение и переводы прошлого: ночью по UTC лимит ещё занят, по Москве сутки новые; прошлые переводы без метки', async () => {
    const history = [{ at: 'night', amountKop: 14_000_000 }];
    const personas = [{ phone: ANNA, topUpKop: 10_000_000, history }];
    await scenario({ defects: ['daily-limit-utc'], bankTime: 'night+70m', personas });
    const blocked = await send(ANNA, 2_000_000, PETR);
    assert.equal(blocked.status, 201);
    const rejected = await settled(blocked.number);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.reasonCode, 'DAILY_LIMIT_EXCEEDED');
    const mine = await probe<Facts>('bank.operations', { label: env.label });
    assert.equal(mine.count, 1);
    const anna = await probe<Facts>('bank.operations', { phone: ANNA });
    assert.equal(anna.count, 5);
    const past = anna.operations.find((item: Facts) => item.amountKop === 14_000_000);
    const fresh = anna.operations.find((item: Facts) => item.amountKop === 2_000_000);
    assert.equal(past.limitAfterKop, 1_000_000);
    assert.equal(fresh.limitBeforeKop, 15_000_000);
    assert.equal(fresh.limitMarginKop, 13_000_000);
    assert.deepEqual((await probe<Facts>('bank.ledger', {})).inconsistent, []);

    await scenario({ defects: [], bankTime: 'night+70m', personas });
    const allowed = await send(ANNA, 2_000_000, PETR);
    assert.notEqual((await settled(allowed.number)).status, 'REJECTED');
  });

  it('перевод на проверке держит лимит: следующий отклонён, пока первый ждёт; флаги операций и остаток клиента', async () => {
    await scenario({ defects: [], bankTime: 'night+30m' });
    const first = await send(ANNA, 10_000_000, GALINA);
    const review = await settled(first.number, (status) => status === 'ON_REVIEW');
    assert.equal(review.status, 'ON_REVIEW');
    const second = await send(ANNA, 6_000_000, PETR);
    await settled(second.number);
    const facts = await probe<Facts>('bank.operations', { label: env.label, phone: ANNA });
    const [one, two] = facts.operations;
    assert.deepEqual([one.wasOnReview, one.createdWhileOtherOnReview, one.limitBeforeKop, one.limitAfterKop], [true, false, 15_000_000, 5_000_000]);
    assert.deepEqual(
      [two.status, two.reasonCode, two.createdWhileOtherOnReview, two.limitBeforeKop, two.limitBeforeRub, two.limitMarginKop],
      ['REJECTED', 'DAILY_LIMIT_EXCEEDED', true, 5_000_000, 50_000, -1_000_000],
    );
    assert.equal(two.clientRemainingRub, 50_000);
    assert.equal(typeof one.antifraudScore, 'number');
    assert.equal(two.antifraudScore, null);
    assert.deepEqual([one.recipientPhone, two.recipientPhone], [GALINA, PETR]);
    await probe('bank.review', { operationId: one.id, decision: 'REJECT' });
    const after = await probe<Facts>('bank.operations', { label: env.label, phone: ANNA });
    assert.equal(after.operations[0].clientRemainingRub, 150_000);
  });

  it('опрос операции: считаются запросы до и после конечного статуса', async () => {
    await scenario({ defects: [] });
    const created = await send(ANNA, 100_000, PETR);
    const poll = () => probe<Facts>('bank.http', { asPhone: ANNA, method: 'GET', path: `/api/v1/operations/${created.operationId}` });
    await poll();
    await settled(created.operationId);
    await poll();
    await poll();
    const log = await probe<Facts>('bank.requestLog', { label: env.label });
    assert.equal(log.polls.length, 1);
    assert.equal(log.polls[0].polls, 3);
    assert.equal(log.maxPolls, 3);
    assert.ok(log.maxPollsAfterTerminal >= 2, `после конечного статуса ${log.maxPollsAfterTerminal}`);
    assert.equal(log.polledTerminalCount, 1);
  });

  it('уведомления в RabbitMQ: сообщения очереди студента проходят схему из образцов, слово уходит в очередь недоставленных', async () => {
    await scenario({ defects: [] });
    await probe('rabbitmq.deleteQueues', { names: ['mobile-notifications'] });
    await probe('rabbitmq.purgeQueues', { names: ['bank.notifications.dlq'] });
    await probe('rabbitmq.importDefinitions', { definitions: NOTIFICATION_DEFINITIONS });
    const created = await send(ANNA, 100_000, PETR);
    await settled(created.operationId);
    const messages = await eventually(
      () => probe<Facts>('rabbitmq.messages', { queue: 'mobile-notifications' }),
      (value) => value.objectCount >= 1,
      15_000,
    );
    assert.ok(messages.objectCount >= 1);
    const first = messages.objects[0];
    const properties = Object.fromEntries(Object.keys(first).map((name) => [name, {}]));
    env.write('notification.schema.json', JSON.stringify({ $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', required: Object.keys(first), properties }));
    const observed = await collectObservations(
      [
        { id: 'queue', probe: 'rabbitmq.messages', params: { queue: 'mobile-notifications' } },
        { id: 'samples', probe: 'jsonschema.samples', params: { file: 'notification.schema.json', samplesFrom: { probe: 'queue', path: 'objects' } } },
      ],
      env.context(),
    );
    assert.equal((observed.samples as Facts).allOk, true);
    assert.deepEqual((observed.samples as Facts).requiredMissing, []);
    env.write('notification-loose.schema.json', JSON.stringify({ type: 'object', properties }));
    const loose = await probe<Facts>('jsonschema.samples', { file: 'notification-loose.schema.json', samples: [{ data: first, expectValid: true }] });
    assert.deepEqual(loose.requiredMissing, Object.keys(first).sort());

    await probe('rabbitmq.publish', { exchange: 'bank.notifications', routingKey: 'notification', payload: 'проверка' });
    const dead = await eventually(
      () => probe<Facts>('rabbitmq.messages', { queue: 'bank.notifications.dlq' }),
      (value) => value.count >= 1,
      15_000,
    );
    assert.deepEqual(dead.bodies, ['проверка']);
    assert.equal(dead.objectCount, 0);
    await probe('rabbitmq.deleteQueues', { names: ['mobile-notifications'] });
    await probe('rabbitmq.purgeQueues', { names: ['bank.notifications.dlq'] });
  });

  it('модель данных в базе банка: ключи пяти таблиц блока переводов читаются из схемы', async () => {
    const tables = ['clients', 'accounts', 'operations', 'postings', 'operation_status_history'];
    const keys = await probe<Facts>('postgres.foreignKeys', { database: 'bank', tables });
    assert.deepEqual(keys.tables, [...tables].sort());
    assert.ok(keys.byTable.accounts.refTables.includes('clients'));
    assert.ok(keys.byTable.postings.refTables.includes('accounts'));
    assert.ok(keys.byTable.postings.refTables.includes('operations'));
    assert.ok(keys.byTable.operation_status_history.refTables.includes('operations'));
    assert.deepEqual(keys.byTable.clients.primaryKey, ['id']);
  });

  it('группы потребителей по топику платежей: группа банка не считается, группа студента с сохранёнными смещениями — да', async () => {
    await scenario({ defects: [] });
    await probe('kafka.deleteConsumerGroups', { topic: 'bank.payments.created' });
    const created = await send(ANNA, 100_000, PETR);
    await settled(created.operationId);
    assert.equal((await probe<Facts>('kafka.consumerGroups', { topic: 'bank.payments.created' })).count, 0);
    const kafka = new Kafka({ clientId: 'live-task', brokers: ['redpanda:9092'], logLevel: logLevel.NOTHING });
    const consumer = kafka.consumer({ groupId: 'autotests' });
    await consumer.connect();
    await consumer.subscribe({ topic: 'bank.payments.created', fromBeginning: true });
    let seen = 0;
    await consumer.run({ eachMessage: async () => void (seen += 1) });
    await eventually(async () => seen, (value) => value >= 1, 15_000, 300);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await consumer.stop();
    await consumer.disconnect();
    const groups = await eventually(
      () => probe<Facts>('kafka.consumerGroups', { topic: 'bank.payments.created' }),
      (value) => value.count >= 1,
      10_000,
    );
    assert.deepEqual(groups.groupIds, ['autotests']);
    assert.deepEqual((await probe<Facts>('kafka.deleteConsumerGroups', { topic: 'bank.payments.created' })).deleted, ['autotests']);
  });

  it('сработавший сбой виден в списке операций: defectCodes у операции с потерянными копейками, пусто у остальных', async () => {
    await scenario({ defects: ['commission-rounding'], personas: [{ phone: PETR, dailyLimitKop: 50_000_000 }] });
    const toBank = (amount: number) =>
      probe<Facts>('bank.http', {
        asPhone: PETR,
        method: 'POST',
        path: '/api/v1/transfers',
        body: { type: 'PHONE_TRANSFER', fromAccount: '40817810400000001002', recipientPhone: '+79000000021', recipientBankCode: 'NORTHWIND', amount },
        headers: { 'Idempotency-Key': key() },
      });
    const free = await toBank(10_000_000);
    await settled(free.number);
    const fee = await toBank(456_789);
    await settled(fee.number);
    const facts = await probe<Facts>('bank.operations', { label: env.label, phone: PETR });
    const byAmount = (amount: number) => facts.operations.find((item: Facts) => item.amountKop === amount);
    assert.deepEqual(byAmount(10_000_000).defectCodes, []);
    assert.deepEqual(byAmount(456_789).defectCodes, ['commission-rounding']);
    assert.equal(typeof byAmount(456_789).antifraudScore, 'number');
    assert.equal(byAmount(456_789).recipientPhone, '+79000000021');
  });
});
