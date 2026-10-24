import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hadOtherOnReview, limitTrace, statusAt, type TraceOperation } from './limit-trace';

const LIMIT = 15_000_000n;
const at = (time: string) => new Date(`2026-10-20T${time}+03:00`);

function operation(number: string, created: string, amount: bigint, status: string, steps: Array<[string, string]> = []): TraceOperation {
  return {
    id: number,
    number,
    type: 'PHONE_TRANSFER',
    status,
    amount,
    createdAt: at(created),
    history: [['CREATED', created] as [string, string], ...steps].map(([name, time]) => ({ status: name, at: at(time) })),
  };
}

const reviewed = operation('ZB1', '23:40:00', 10_000_000n, 'ON_REVIEW', [['CHECKING', '23:40:01'], ['ON_REVIEW', '23:40:02']]);
const rejected = operation('ZB2', '23:41:00', 6_000_000n, 'REJECTED', [['CHECKING', '23:41:01'], ['REJECTED', '23:41:02']]);

describe('limitTrace: остаток лимита до и после каждого перевода', () => {
  it('перевод на проверке держит лимит: следующий видит остаток без него', () => {
    const all = [reviewed, rejected];
    assert.deepEqual(limitTrace(reviewed, all, LIMIT), { beforeKop: 15_000_000n, afterKop: 5_000_000n });
    assert.deepEqual(limitTrace(rejected, all, LIMIT), { beforeKop: 5_000_000n, afterKop: 5_000_000n });
  });

  it('отклонённый оператором позже перевод в момент следующего ещё держал лимит', () => {
    const lateReject = { ...reviewed, status: 'REJECTED', history: [...reviewed.history, { status: 'REJECTED', at: at('23:50:00') }] };
    assert.equal(limitTrace(rejected, [lateReject, rejected], LIMIT)?.beforeKop, 5_000_000n);
    assert.equal(limitTrace(lateReject, [lateReject, rejected], LIMIT)?.afterKop, 15_000_000n);
  });

  it('перевод ровно на остаток оставляет ноль, превышение не уходит в минус', () => {
    const exact = operation('ZB3', '12:00:00', LIMIT, 'COMPLETED', [['COMPLETED', '12:00:02']]);
    assert.deepEqual(limitTrace(exact, [exact], LIMIT), { beforeKop: LIMIT, afterKop: 0n });
    const over = operation('ZB4', '12:01:00', 100n, 'REJECTED', [['REJECTED', '12:01:01']]);
    assert.deepEqual(limitTrace(over, [exact, over], LIMIT), { beforeKop: 0n, afterKop: 0n });
  });

  it('вчерашние переводы и переводы не по телефону лимит не расходуют', () => {
    const yesterday = { ...operation('ZB5', '12:00:00', 9_000_000n, 'COMPLETED'), createdAt: new Date('2026-10-19T21:30:00+03:00') };
    const own = { ...operation('ZB6', '12:00:00', 9_000_000n, 'COMPLETED'), type: 'OWN_TRANSFER' };
    const today = operation('ZB7', '12:05:00', 100n, 'COMPLETED');
    assert.equal(limitTrace(today, [yesterday, own, today], LIMIT)?.beforeKop, LIMIT);
    assert.equal(limitTrace(own, [own], LIMIT), null);
  });
});

describe('статус операции на момент и перевод на проверке у клиента', () => {
  it('статус берётся из истории на нужный момент', () => {
    assert.equal(statusAt(reviewed, at('23:40:00')), 'CREATED');
    assert.equal(statusAt(reviewed, at('23:40:30')), 'ON_REVIEW');
  });

  it('второй перевод создан, пока первый на проверке; после решения оператора флага нет', () => {
    assert.equal(hadOtherOnReview(rejected, [reviewed, rejected]), true);
    assert.equal(hadOtherOnReview(reviewed, [reviewed, rejected]), false);
    const decided = { ...reviewed, history: [...reviewed.history, { status: 'PROCESSING', at: at('23:40:30') }] };
    assert.equal(hadOtherOnReview(rejected, [decided, rejected]), false);
  });
});
