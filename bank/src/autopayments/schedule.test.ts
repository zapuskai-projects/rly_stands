import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addDays,
  decideAfterFailure,
  firstRunDate,
  isDue,
  isReminderDue,
  isValidDateKey,
  nextCycleDate,
  nextOccurrence,
  runKey,
} from './schedule';

const moscow = (value: string) => new Date(`${value}+03:00`);

describe('расписание автоплатежа', () => {
  it('следующее число месяца: в этом месяце, если оно впереди, иначе в следующем, через границу года тоже', () => {
    assert.equal(nextOccurrence(15, '2026-10-10'), '2026-10-15');
    assert.equal(nextOccurrence(15, '2026-10-15'), '2026-11-15');
    assert.equal(nextOccurrence(5, '2026-12-20'), '2027-01-05');
    assert.equal(nextOccurrence(28, '2027-01-31'), '2027-02-28');
  });

  it('сдвиг дат на дни считает по календарю', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });

  it('первый платёж: в день платежа до 10:00 — сегодня, после — через месяц', () => {
    assert.equal(firstRunDate(moscow('2026-10-15T09:59:00'), 15), '2026-10-15');
    assert.equal(firstRunDate(moscow('2026-10-15T10:00:00'), 15), '2026-11-15');
    assert.equal(firstRunDate(moscow('2026-10-20T12:00:00'), 15), '2026-11-15');
    assert.equal(firstRunDate(moscow('2026-10-01T12:00:00'), 15), '2026-10-15');
  });

  it('платёж наступил в 10:00 дня платежа и остаётся наступившим после', () => {
    assert.equal(isDue(moscow('2026-10-15T09:59:59'), '2026-10-15'), false);
    assert.equal(isDue(moscow('2026-10-15T10:00:00'), '2026-10-15'), true);
    assert.equal(isDue(moscow('2026-10-16T00:00:00'), '2026-10-15'), true);
    assert.equal(isDue(moscow('2026-10-14T23:59:59'), '2026-10-15'), false);
  });

  it('напоминание — накануне с 18:00', () => {
    assert.equal(isReminderDue(moscow('2026-10-14T17:59:59'), '2026-10-15'), false);
    assert.equal(isReminderDue(moscow('2026-10-14T18:00:00'), '2026-10-15'), true);
    assert.equal(isReminderDue(moscow('2026-10-15T09:00:00'), '2026-10-15'), false);
    assert.equal(isReminderDue(moscow('2026-10-13T20:00:00'), '2026-10-15'), false);
  });

  it('следующая дата после исполнения: ближайшее число после платежа и после сегодняшнего дня, за датой окончания — конец', () => {
    assert.equal(nextCycleDate(15, '2026-10-15', moscow('2026-10-15T10:01:00'), null), '2026-11-15');
    assert.equal(nextCycleDate(15, '2026-10-15', moscow('2026-10-17T10:01:00'), null), '2026-11-15');
    assert.equal(nextCycleDate(15, '2026-10-15', moscow('2026-12-20T10:01:00'), null), '2027-01-15');
    assert.equal(nextCycleDate(15, '2026-10-15', moscow('2026-10-15T10:01:00'), '2026-11-15'), '2026-11-15');
    assert.equal(nextCycleDate(15, '2026-10-15', moscow('2026-10-15T10:01:00'), '2026-11-14'), null);
  });

  it('следующий цикл считается от даты платежа, а не от даты повтора', () => {
    assert.equal(nextCycleDate(28, '2026-10-28', moscow('2026-10-25T10:01:00'), null), '2026-11-28');
    assert.equal(nextCycleDate(28, '2026-10-28', moscow('2026-10-28T10:01:00'), null), '2026-11-28');
    assert.equal(nextCycleDate(28, '2026-10-28', moscow('2026-12-01T10:01:00'), null), '2026-12-28');
  });

  it('ключ повтора содержит автоплатёж, дату платежа и попытку, у новой серии после возобновления — ещё и номер серии', () => {
    assert.equal(runKey('abc', '2026-10-15', 2), 'autopay:abc:2026-10-15:2');
    assert.equal(runKey('abc', '2026-10-15', 1, 1), 'autopay:abc:2026-10-15:1');
    assert.equal(runKey('abc', '2026-10-15', 1, 2), 'autopay:abc:2026-10-15:1:s2');
  });

  it('повтор только при нехватке денег и лимите, и только пока попыток меньше трёх', () => {
    assert.equal(decideAfterFailure('INSUFFICIENT_FUNDS', 1), 'RETRY');
    assert.equal(decideAfterFailure('DAILY_LIMIT_EXCEEDED', 2), 'RETRY');
    assert.equal(decideAfterFailure('INSUFFICIENT_FUNDS', 3), 'FAIL');
    assert.equal(decideAfterFailure('ACCOUNT_ARRESTED', 1), 'FAIL');
    assert.equal(decideAfterFailure('ANTIFRAUD_REJECTED', 1), 'FAIL');
    assert.equal(decideAfterFailure('OPERATOR_REJECTED', 1), 'FAIL');
  });

  it('со сбоем нехватка денег не повторяется, лимит повторяется', () => {
    assert.equal(decideAfterFailure('INSUFFICIENT_FUNDS', 1, true), 'FAIL');
    assert.equal(decideAfterFailure('DAILY_LIMIT_EXCEEDED', 1, true), 'RETRY');
  });

  it('дата окончания проверяется как настоящая календарная дата', () => {
    assert.equal(isValidDateKey('2026-02-28'), true);
    assert.equal(isValidDateKey('2026-02-30'), false);
    assert.equal(isValidDateKey('26-02-28'), false);
  });
});
