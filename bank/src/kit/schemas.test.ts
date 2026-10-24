import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BankError } from '../shared/errors';
import { kitSchemas, parseKit } from './schemas';

const BASE = { label: 'task-6:attempt-1', defects: [], sbpMode: 'NORMAL', bankTime: null };

function failure(run: () => unknown): BankError {
  try {
    run();
  } catch (error) {
    if (error instanceof BankError) return error;
    throw error;
  }
  throw new Error('ожидалась ошибка проверки');
}

const fields = (error: BankError) => (error.details ?? []).map((item) => item.field);

describe('тело сценария банка', () => {
  it('минимальный сценарий разбирается, время остаётся пустым', () => {
    const parsed = parseKit(kitSchemas.scenario, BASE);
    assert.equal(parsed.label, 'task-6:attempt-1');
    assert.deepEqual(parsed.defects, []);
    assert.equal(parsed.bankTime, null);
    assert.equal(parsed.tariffs, undefined);
  });

  it('релиз без указания — 1.0, указанный принимается, неизвестный отвергается', () => {
    assert.equal(parseKit(kitSchemas.scenario, BASE).release, '1.0');
    assert.equal(parseKit(kitSchemas.scenario, { ...BASE, release: '1.1' }).release, '1.1');
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, release: '2.0' }))), ['release']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, release: 1.1 }))), ['release']);
  });

  it('время банка со смещением и в UTC разбирается точно, без смещения считается московским', () => {
    assert.equal(parseKit(kitSchemas.scenario, { ...BASE, bankTime: '2026-10-20T23:40:00+03:00' }).bankTime?.toISOString(), '2026-10-20T20:40:00.000Z');
    assert.equal(parseKit(kitSchemas.scenario, { ...BASE, bankTime: '2026-10-20T20:40:00Z' }).bankTime?.toISOString(), '2026-10-20T20:40:00.000Z');
    assert.equal(parseKit(kitSchemas.scenario, { ...BASE, bankTime: '2026-10-20T23:40' }).bankTime?.toISOString(), '2026-10-20T20:40:00.000Z');
    assert.equal(parseKit(kitSchemas.scenario, { ...BASE, bankTime: '2026-10-20T23:40:00.250' }).bankTime?.toISOString(), '2026-10-20T20:40:00.250Z');
  });

  it('невозможный и неформатный момент времени отвергается', () => {
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, bankTime: '2026-13-40T25:61:00Z' }))), ['bankTime']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, bankTime: 'вчера вечером' }))), ['bankTime']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, bankTime: undefined }))), ['bankTime']);
  });

  it('коды сбоев проверяются по каталогу, ошибка называет позицию', () => {
    const ok = parseKit(kitSchemas.scenario, { ...BASE, defects: ['limit-boundary', 'kafka-amount-mismatch'] });
    assert.deepEqual(ok.defects, ['limit-boundary', 'kafka-amount-mismatch']);
    const error = failure(() => parseKit(kitSchemas.scenario, { ...BASE, defects: ['limit-boundary', 'нет-такого'] }));
    assert.equal(error.status, 400);
    assert.equal(error.code, 'VALIDATION_ERROR');
    assert.deepEqual(fields(error), ['defects.1']);
  });

  it('режим СБП только из четырёх, метка только из допустимых символов', () => {
    for (const mode of ['NORMAL', 'REJECT', 'TIMEOUT', 'UNAVAILABLE']) assert.equal(parseKit(kitSchemas.scenario, { ...BASE, sbpMode: mode }).sbpMode, mode);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, sbpMode: 'DOWN' }))), ['sbpMode']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, label: 'с пробелом' }))), ['label']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, label: '' }))), ['label']);
  });

  it('лишние и недостающие поля отвергаются, пустое тело — тоже', () => {
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, extra: 1 }))), ['body']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { label: 'x' }))).sort(), ['bankTime', 'defects', 'sbpMode']);
    assert.ok(fields(failure(() => parseKit(kitSchemas.scenario, undefined))).length >= 4);
  });

  it('тарифы и персоны разбираются по полям, суммы только целые неотрицательные копейки', () => {
    const parsed = parseKit(kitSchemas.scenario, {
      ...BASE,
      tariffs: [{ code: 'START', dailyLimitKop: 10_000_000, rateBps: 150 }],
      personas: [{ phone: '+79001110001', dailyLimitKop: null, accountStatus: 'ARRESTED' }],
    });
    assert.equal(parsed.tariffs?.[0]?.dailyLimitKop, 10_000_000);
    assert.equal(parsed.personas?.[0]?.dailyLimitKop, null);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, tariffs: [{ code: 'START', minKop: 1.5 }] }))), ['tariffs.0.minKop']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, tariffs: [{ code: 'START', maxKop: -1 }] }))), ['tariffs.0.maxKop']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, tariffs: [{ code: 'START', rateBps: 10_001 }] }))), ['tariffs.0.rateBps']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.scenario, { ...BASE, personas: [{ phone: '12345' }] }))), ['personas.0.phone']);
  });
});

describe('тела действий банка', () => {
  const transfer = { phone: '+79001110001', toPhone: '+79001110002', amountKop: 150_000, idempotencyKey: 'ref-run-0001', label: 'verify:6' };

  it('перевод по телефону и между своими счетами различаются получателем, нужен ровно один', () => {
    assert.equal(parseKit(kitSchemas.transferAction, transfer).toPhone, '+79001110002');
    const own = { phone: transfer.phone, toOwnAccount: '40817810800000001001', amountKop: 100, idempotencyKey: transfer.idempotencyKey, label: transfer.label };
    assert.equal(parseKit(kitSchemas.transferAction, own).toOwnAccount, '40817810800000001001');
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.transferAction, { ...transfer, toOwnAccount: '40817810800000001001' }))), ['toPhone']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.transferAction, { ...transfer, toPhone: undefined }))), ['toPhone']);
  });

  it('сумма положительная целая, ключ повтора и метка по шаблону', () => {
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.transferAction, { ...transfer, amountKop: 0 }))), ['amountKop']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.transferAction, { ...transfer, amountKop: 10.5 }))), ['amountKop']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.transferAction, { ...transfer, idempotencyKey: 'short' }))), ['idempotencyKey']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.transferAction, { ...transfer, label: 'a b' }))), ['label']);
  });

  it('решение по проверке: идентификатор операции и одно из двух решений', () => {
    const id = '6f6c7c0e-3c3e-4a39-9d2c-7b1b6a8f9a10';
    assert.equal(parseKit(kitSchemas.reviewAction, { operationId: id, decision: 'APPROVE' }).comment, undefined);
    assert.equal(parseKit(kitSchemas.reviewAction, { operationId: id, decision: 'REJECT', comment: 'нет' }).comment, 'нет');
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.reviewAction, { operationId: 'не uuid', decision: 'APPROVE' }))), ['operationId']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.reviewAction, { operationId: id, decision: 'MAYBE' }))), ['decision']);
  });

  it('фильтры фактов: статус из списка, метка и телефон по шаблону, лишнее отвергается', () => {
    assert.deepEqual(parseKit(kitSchemas.operationsQuery, { status: 'COMPLETED', phone: '+79001110001', label: 'l1' }), { status: 'COMPLETED', phone: '+79001110001', label: 'l1' });
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.operationsQuery, { status: 'DONE' }))), ['status']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.operationsQuery, { limit: '5' }))), ['body']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.requestsQuery, {}))), ['label']);
    assert.deepEqual(fields(failure(() => parseKit(kitSchemas.ledgerQuery, { account: '123' }))), ['account']);
    assert.deepEqual(parseKit(kitSchemas.ledgerQuery, {}), {});
  });
});
