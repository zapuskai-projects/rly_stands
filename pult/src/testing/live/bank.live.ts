import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, it } from 'node:test';
import { READINESS } from '../../modules/readiness';
import { runActions } from '../../probes/run';
import { eventually, liveSuite, type LiveEnv } from './support';

type Facts = Record<string, any>;

const PETR = '+79001110002';
const ACCOUNT_ANNA = '40817810800000001000';
const ANNA = '+79001110001';
const OTHER_BANK = { toPhone: '+79000000021', toBankCode: 'NORTHWIND' };
const FINAL = new Set(['COMPLETED', 'REJECTED', 'FAILED', 'REFUNDED']);
const DECIDED = new Set([...FINAL, 'ON_REVIEW']);

let counter = 0;
const key = () => `live-${Date.now()}-${(counter += 1)}`;

async function settled(env: LiveEnv, id: string, done: (status: string) => boolean = (status) => FINAL.has(status), timeoutMs = 20_000) {
  return eventually(
    () => env.probe<Facts>('bank.operation', { id }),
    (value) => value.exists === true && done(value.status),
    timeoutMs,
    400,
  );
}

const codes = (operation: Facts) => operation.defects.map((item: Facts) => item.code);

liveSuite('bank', READINESS.bank ?? [], 'ЗапускБанк: проверки и действия пульта на живом банке', (env) => {
  const { probe } = env;

  before(async () => {
    writeFileSync(join(env.dataDir(), 'bank-secret'), `${process.env.KIT_LIVE_BANK_SECRET ?? ''}\n`);
    await probe('bank.scenario', { reset: true, defects: [], bankTime: 'noon' });
    const warmup = await probe<Facts>('bank.transfer', { phone: PETR, toPhone: ANNA, amountKop: 100, idempotencyKey: key() });
    await settled(env, warmup.operationId, (status) => DECIDED.has(status), 90_000);
  });

  const scenario = (params: Record<string, unknown>) => probe('bank.scenario', { reset: true, bankTime: 'noon', ...params });
  const transfer = (params: Record<string, unknown>) =>
    probe<Facts>('bank.transfer', { phone: PETR, toPhone: ANNA, idempotencyKey: key(), ...params });

  it('банк принимает секрет пульта, чужой секрет — сбой проверки, а не «операции нет»', async () => {
    await scenario({ defects: [] });
    const ledger = await probe<Facts>('bank.ledger', {});
    assert.deepEqual(ledger.inconsistent, []);
    const tariff = await probe<Facts>('bank.tariff', { code: 'START' });
    assert.equal(tariff.exists, true);
    assert.ok(tariff.dailyLimitKop > 0);
    assert.equal((await probe<Facts>('bank.tariff', { code: 'NO_SUCH' })).exists, false);
    const secretFile = join(env.dataDir(), 'bank-secret');
    writeFileSync(secretFile, 'wrong-secret\n');
    try {
      await assert.rejects(probe('bank.operation', { id: 'ZB0000000001' }), /не принял секрет/);
    } finally {
      writeFileSync(secretFile, `${process.env.KIT_LIVE_BANK_SECRET ?? ''}\n`);
    }
    assert.equal((await probe<Facts>('bank.operation', { id: 'ZB0000000001' })).exists, false);
  });

  it('перевод без дефектов: операция завершается, пометок нет, книга сходится', async () => {
    await scenario({ defects: [] });
    const created = await transfer({ amountKop: 100_000 });
    assert.ok(created.number);
    const operation = await settled(env, created.operationId);
    assert.equal(operation.status, 'COMPLETED');
    assert.deepEqual(operation.defects, []);
    assert.equal(operation.postings.length > 0, true);
    const listed = await probe<Facts>('bank.operations', { label: env.label });
    assert.equal(listed.count, 1);
    const log = await probe<Facts>('bank.requestLog', { label: env.label });
    assert.ok(log.count >= 1);
    assert.deepEqual((await probe<Facts>('bank.ledger', {})).inconsistent, []);
  });

  it('limit-boundary: перевод ровно на суточный лимит отклоняется', async () => {
    await scenario({ defects: ['limit-boundary'] });
    const operation = await settled(env, (await transfer({ amountKop: 15_000_000 })).operationId);
    assert.equal(operation.status, 'REJECTED');
    assert.equal(operation.reasonCode, 'DAILY_LIMIT_EXCEEDED');
    assert.deepEqual(codes(operation), ['limit-boundary']);
    assert.equal(operation.defects[0].details.expected, 'ACCEPTED');
    await scenario({ defects: [] });
    const clean = await settled(env, (await transfer({ amountKop: 15_000_000 })).operationId);
    assert.equal(clean.status, 'COMPLETED');
    assert.deepEqual(clean.defects, []);
  });

  it('idempotency-double-debit: повтор с тем же ключом создаёт вторую операцию', async () => {
    const repeated = key();
    await scenario({ defects: ['idempotency-double-debit'] });
    const first = await transfer({ amountKop: 150_000, idempotencyKey: repeated });
    const second = await transfer({ amountKop: 150_000, idempotencyKey: repeated });
    assert.notEqual(second.operationId, first.operationId);
    assert.equal((await probe<Facts>('bank.operations', { label: env.label })).count, 2);
    const marked = await settled(env, second.operationId);
    assert.deepEqual(codes(marked), ['idempotency-double-debit']);
    assert.equal(marked.defects[0].details.firstOperationId, first.operationId);
    await scenario({ defects: [] });
    const clean = key();
    const one = await transfer({ amountKop: 150_000, idempotencyKey: clean });
    const two = await transfer({ amountKop: 150_000, idempotencyKey: clean });
    assert.equal(two.operationId, one.operationId);
    assert.equal((await probe<Facts>('bank.operations', { label: env.label })).count, 1);
  });

  it('commission-rounding: комиссия без копеек, пометка с ожидаемым и фактическим значением', async () => {
    const tariff = { code: 'START', freeMonthlyKop: 0, rateBps: 100, minKop: 3000, maxKop: 150_000 };
    await scenario({ defects: ['commission-rounding'] });
    await probe('bank.setTariff', tariff);
    const wrong = await settled(env, (await transfer({ amountKop: 456_789, ...OTHER_BANK })).operationId, () => true);
    assert.deepEqual(codes(wrong), ['commission-rounding']);
    assert.equal(wrong.defects[0].details.expected, 4568);
    assert.equal(wrong.defects[0].details.actual, 4500);
    assert.equal(wrong.feeKop, 4500);
    await scenario({ defects: [] });
    await probe('bank.setTariff', tariff);
    const right = await settled(env, (await transfer({ amountKop: 456_789, ...OTHER_BANK })).operationId, () => true);
    assert.deepEqual(right.defects, []);
    assert.equal(right.feeKop, 4568);
  });

  it('daily-limit-utc: ночью по Москве сутки считаются по UTC', async () => {
    const night = { defects: ['daily-limit-utc'] };
    await scenario({ ...night, bankTime: '2026-10-10T20:30:00Z' });
    const evening = await settled(env, (await transfer({ amountKop: 9_000_000 })).operationId, (status) => DECIDED.has(status));
    assert.notEqual(evening.status, 'REJECTED');
    await probe('bank.scenario', { ...night, bankTime: '2026-10-10T21:40:00Z' });
    const after = await settled(env, (await transfer({ amountKop: 9_000_000 })).operationId, (status) => DECIDED.has(status));
    assert.equal(after.status, 'REJECTED');
    assert.equal(after.reasonCode, 'DAILY_LIMIT_EXCEEDED');
    assert.deepEqual(codes(after), ['daily-limit-utc']);
    await scenario({ defects: [], bankTime: '2026-10-10T20:30:00Z' });
    await settled(env, (await transfer({ amountKop: 9_000_000 })).operationId, (status) => DECIDED.has(status));
    await probe('bank.scenario', { defects: [], bankTime: '2026-10-10T21:40:00Z' });
    const clean = await settled(env, (await transfer({ amountKop: 9_000_000 })).operationId, (status) => DECIDED.has(status));
    assert.notEqual(clean.status, 'REJECTED');
    assert.deepEqual(clean.defects, []);
  });

  it('sbp-timeout-stuck: при тайм-ауте СБП операция зависает, без дефекта деньги возвращаются', async () => {
    await scenario({ defects: ['sbp-timeout-stuck'], sbpMode: 'TIMEOUT' });
    const created = await transfer({ amountKop: 505_000, ...OTHER_BANK });
    const stuck = await settled(env, created.operationId, (status) => FINAL.has(status), 25_000);
    assert.equal(stuck.status, 'PROCESSING');
    assert.deepEqual(codes(stuck), ['sbp-timeout-stuck']);
    assert.equal(stuck.defects[0].details.expected, 'REFUNDED');
    await scenario({ defects: [], sbpMode: 'TIMEOUT' });
    const refunded = await settled(env, (await transfer({ amountKop: 505_000, ...OTHER_BANK })).operationId, undefined, 30_000);
    assert.equal(refunded.status, 'REFUNDED');
    assert.deepEqual(refunded.defects, []);
  });

  it('notify-before-complete: сообщение о выполненном переводе приходит до проведения', async () => {
    const notificationsOf = (id: string, ready: (count: number) => boolean) =>
      eventually(() => probe<Facts>('bank.notifications', { operationId: id }), (value) => ready(value.count), 10_000);
    await scenario({ defects: ['notify-before-complete'] });
    const operation = await settled(env, (await transfer({ amountKop: 505_000, ...OTHER_BANK })).operationId);
    assert.deepEqual(codes(operation), ['notify-before-complete']);
    const early = await notificationsOf(operation.id, (count) => count >= 1);
    assert.equal(early.exists, true);
    assert.equal(early.anyBeforeCompletion, true);
    await scenario({ defects: [] });
    const clean = await settled(env, (await transfer({ amountKop: 505_000, ...OTHER_BANK })).operationId);
    const notifications = await notificationsOf(clean.id, (count) => count >= 1);
    assert.ok(notifications.count >= 1);
    assert.equal(notifications.anyBeforeCompletion, false);
  });

  it('kafka-amount-mismatch: в событии сумма рублями с дробью вместо копеек', async () => {
    await scenario({ defects: ['kafka-amount-mismatch'] });
    const created = await transfer({ amountKop: 150_050 });
    const operation = await settled(env, created.operationId);
    assert.deepEqual(codes(operation), ['kafka-amount-mismatch']);
    const event = await eventually(
      () => probe<Facts>('kafka.messages', { topic: 'bank.payments.created', match: created.operationId }),
      (value) => value.count >= 1,
      10_000,
    );
    assert.equal(event.count, 1);
    assert.equal(event.messages[0].value.amount, 1500.5);
    assert.ok(event.fields.includes('operationNumber'));
    await scenario({ defects: [] });
    const clean = await transfer({ amountKop: 150_050 });
    const cleanEvent = await eventually(
      () => probe<Facts>('kafka.messages', { topic: 'bank.payments.created', match: clean.operationId }),
      (value) => value.count >= 1,
      10_000,
    );
    assert.equal(cleanEvent.messages[0].value.amount, 150_050);
  });

  it('эталон по действиям: перевод с именем и баг-репорт с номером его операции', async () => {
    const saved: Array<Record<string, string>> = [];
    await scenario({ defects: ['limit-boundary'] });
    const failure = await runActions(
      [
        {
          action: 'bank.transfer',
          as: 'transfer',
          params: { phone: PETR, toPhone: ANNA, amountKop: 15_000_000, idempotencyKey: 'live01-ref-limit' },
        },
        { action: 'platform.report', params: { title: 'Лимит', operationId: '{{result.transfer.number}}' } },
      ],
      { ...env.context(), saveReport: async (report) => void saved.push(report) },
    );
    assert.equal(failure, null);
    const listed = await probe<Facts>('bank.operations', { label: env.label });
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.operationId, listed.operations[0].number);
  });

  const personaTraces = async () => ({
    anna: (await probe<Facts>('bank.operations', { phone: ANNA })).count,
    petr: (await probe<Facts>('bank.operations', { phone: PETR })).count,
  });

  it('bank.run: пять путей перевода от технического клиента с историями статусов, ручной проверкой и тайм-аутом', async () => {
    await scenario({ defects: [] });
    const before = await personaTraces();
    const external = { toPhone: '+79000000021', toBankCode: 'NORTHWIND' };
    const run = await probe<Facts>('bank.run', {
      timeoutMs: 80_000,
      client: { tariffCode: 'START', balanceKop: 50_000_000 },
      recipient: { tariffCode: 'START', balanceKop: 100 },
      steps: [
        { scenario: { bankTime: '2026-10-21T23:40' } },
        { transfer: { phone: 'client', toPhone: 'recipient', amountKop: 2_000_000, idempotencyKey: 'live-run-night' } },
        { review: { decision: 'APPROVE', comment: 'Проверено' } },
        { scenario: { bankTime: 'noon' } },
        { transfer: { phone: 'client', toPhone: 'recipient', amountKop: 100_000, idempotencyKey: 'live-run-int' } },
        { transfer: { phone: 'client', toPhone: 'recipient', amountKop: 15_000_001, idempotencyKey: 'live-run-limit' } },
        { scenario: { bankTime: 'noon', sbpMode: 'REJECT' } },
        { transfer: { phone: 'client', ...external, amountKop: 100_000, idempotencyKey: 'live-run-rej' } },
        { scenario: { bankTime: 'noon', sbpMode: 'TIMEOUT' } },
        { transfer: { phone: 'client', ...external, amountKop: 100_000, idempotencyKey: 'live-run-tmo' } },
        { scenario: { bankTime: null } },
      ],
    });
    assert.equal(run.completed, true);
    assert.match(run.client.phone, /^\+79[0-9]{9}$/);
    assert.match(run.recipient.phone, /^\+79[0-9]{9}$/);
    assert.notEqual(run.client.phone, run.recipient.phone);
    assert.deepEqual(run.operations.map((operation: Facts) => operation.status), ['COMPLETED', 'COMPLETED', 'REJECTED', 'FAILED', 'REFUNDED']);
    assert.deepEqual(await personaTraces(), before, 'прогон не оставил следов у Анны и Петра');
    for (const transition of [
      'CREATED -> CHECKING',
      'CHECKING -> PROCESSING',
      'PROCESSING -> COMPLETED',
      'CHECKING -> ON_REVIEW',
      'ON_REVIEW -> PROCESSING',
      'CHECKING -> REJECTED',
      'PROCESSING -> FAILED',
      'PROCESSING -> REFUNDED',
    ]) {
      assert.ok(run.transitions.includes(transition), `нет перехода ${transition}`);
    }
    await scenario({ defects: [] });
  });

  it('bank.run: на каждый прогон новый технический клиент, комиссия не зависит от прежних прогонов', async () => {
    await scenario({ defects: [] });
    const before = await personaTraces();
    const steps = [
      { scenario: { bankTime: 'noon' } },
      { transfer: { phone: 'client', toPhone: '+79000000021', toBankCode: 'NORTHWIND', amountKop: 14_000_000, idempotencyKey: 'live-iso-1' } },
      { transfer: { phone: 'client', toPhone: '+79000000021', toBankCode: 'NORTHWIND', amountKop: 3_000_000, idempotencyKey: 'live-iso-2' } },
    ];
    await probe('bank.setTariff', { code: 'START', dailyLimitKop: 20_000_000, freeMonthlyKop: 15_000_000, rateBps: 50, minKop: 2000, maxKop: 100_000 });
    const phones: string[] = [];
    for (const attempt of [1, 2]) {
      const run = await probe<Facts>('bank.run', {
        client: { tariffCode: 'START', balanceKop: 30_000_000 },
        steps,
        timeoutMs: 60_000,
      });
      assert.deepEqual(run.operations.map((operation: Facts) => operation.feeKop), [0, 10_000], `прогон ${attempt}`);
      phones.push(run.client.phone);
    }
    assert.notEqual(phones[0], phones[1]);
    assert.equal((await probe<Facts>('bank.operations', { label: env.label })).count, 4);
    assert.deepEqual(await personaTraces(), before);
  });

  it('bank.http: настоящий вызов API от имени клиента пишет журнал запросов с кодами, повтором и дублями ключей', async () => {
    await scenario({ defects: [] });
    const body = { type: 'PHONE_TRANSFER', fromAccount: ACCOUNT_ANNA, recipientPhone: PETR, amount: 10_000 };
    const send = (extra: Record<string, unknown>, key: string) =>
      probe<Facts>('bank.http', { asPhone: ANNA, method: 'POST', path: '/api/v1/transfers', body: { ...body, ...extra }, headers: { 'Idempotency-Key': key } });
    const first = await send({}, 'live-http-ok');
    assert.equal(first.status, 201);
    assert.ok(first.number);
    const again = await send({}, 'live-http-ok');
    assert.equal(again.status, 200);
    assert.equal(again.replayed, true);
    assert.equal((await send({ recipientPhone: '9001110002' }, 'live-http-phone')).code, 'VALIDATION_ERROR');
    const poor = await send({ amount: 14_000_000 }, 'live-http-funds');
    assert.equal(poor.status, 422);
    assert.equal(poor.code, 'INSUFFICIENT_FUNDS');
    const log = await probe<Facts>('bank.requestLog', { label: env.label });
    const posts = log.requests.filter((request: Facts) => request.path === '/api/v1/transfers');
    assert.deepEqual(posts.map((request: Facts) => request.status), [201, 200, 400, 422]);
    assert.equal(log.requests.find((request: Facts) => request.replayed === true)?.status, 200);
    assert.deepEqual(log.duplicateKeys, [{ key: 'live-http-ok', count: 2 }]);
    await eventually(
      () => probe<Facts>('bank.operation', { id: first.number }),
      (value) => value.status === 'COMPLETED',
      15_000,
    );
  });

  it('факты операции: возраст по банковскому времени растёт, копейки отмечены', async () => {
    await scenario({ defects: [] });
    const round = await transfer({ amountKop: 150_000 });
    const withKopecks = await transfer({ amountKop: 150_050 });
    const before = await probe<Facts>('bank.operation', { id: withKopecks.number });
    assert.equal(before.hasKopecks, true);
    assert.equal((await probe<Facts>('bank.operation', { id: round.number })).hasKopecks, false);
    await probe('kit.wait', { seconds: 3 });
    const after = await probe<Facts>('bank.operation', { id: withKopecks.number });
    assert.ok(after.ageSeconds >= before.ageSeconds + 2, `${before.ageSeconds} -> ${after.ageSeconds}`);
    await probe('bank.scenario', { defects: [], bankTime: '2026-10-19T10:00' });
    await probe('kit.wait', { seconds: 3 });
    assert.ok((await probe<Facts>('bank.operation', { id: withKopecks.number })).ageSeconds === 0);
    await scenario({ defects: [] });
  });

  it('расхождение остатка: SQL по базе банка портит счёт, bank.ledgerScan и bank.ledger его находят', async () => {
    await scenario({ defects: [] });
    assert.equal((await probe<Facts>('bank.ledgerScan', {})).count, 0);
    await probe('postgres.sql', {
      database: 'bank',
      sql: `UPDATE accounts SET balance_kop = balance_kop + 100 * (1 + abs(hashtext('${env.label}')) % 999) WHERE id = (SELECT id FROM accounts WHERE client_id IS NOT NULL ORDER BY md5(number || '${env.label}') LIMIT 1)`,
    });
    const scan = await probe<Facts>('bank.ledgerScan', {});
    assert.equal(scan.count, 1);
    assert.match(scan.account, /^[0-9]{20}$/);
    assert.ok(scan.balanceKop - scan.postingsSumKop >= 100 && scan.balanceKop - scan.postingsSumKop <= 99_900);
    assert.equal((await probe<Facts>('bank.ledger', {})).inconsistent[0].account, scan.account);
    await scenario({ defects: [] });
    assert.equal((await probe<Facts>('bank.ledgerScan', {})).count, 0);
  });
});
