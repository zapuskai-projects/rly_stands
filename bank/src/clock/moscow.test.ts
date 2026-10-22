import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  moscowDateKey,
  moscowDayStart,
  moscowMonthStart,
  moscowNextDayStart,
  moscowNextMonthStart,
  moscowParts,
  parseMoscowDate,
  toMoscowIso,
} from './moscow';

describe('московские сутки', () => {
  it('21:00 UTC — уже новые сутки по Москве', () => {
    const lastMomentOfDay = new Date('2026-10-20T20:59:59.999Z');
    const firstMomentOfNextDay = new Date('2026-10-20T21:00:00.000Z');
    assert.equal(moscowDateKey(lastMomentOfDay), '2026-10-20');
    assert.equal(moscowDateKey(firstMomentOfNextDay), '2026-10-21');
  });

  it('начало суток по Москве — 21:00 UTC предыдущего дня', () => {
    assert.equal(moscowDayStart(new Date('2026-10-20T12:00:00Z')).toISOString(), '2026-10-19T21:00:00.000Z');
    assert.equal(moscowDayStart(new Date('2026-10-20T20:59:59.999Z')).toISOString(), '2026-10-19T21:00:00.000Z');
    assert.equal(moscowDayStart(new Date('2026-10-20T21:00:00.000Z')).toISOString(), '2026-10-20T21:00:00.000Z');
  });

  it('конец суток исключающий и совпадает с началом следующих', () => {
    const instant = new Date('2026-10-20T20:40:00Z');
    assert.equal(moscowNextDayStart(instant).toISOString(), '2026-10-20T21:00:00.000Z');
    assert.equal(moscowNextDayStart(instant).getTime(), moscowDayStart(new Date('2026-10-20T21:00:00Z')).getTime());
  });

  it('23:40 по Москве — это 20:40 UTC того же дня', () => {
    const p = moscowParts(new Date('2026-10-20T20:40:00Z'));
    assert.deepEqual([p.year, p.month, p.day, p.hour, p.minute], [2026, 10, 20, 23, 40]);
  });

  it('сутки в UTC и в Москве расходятся между 21:00 и 24:00 UTC', () => {
    const instant = new Date('2026-10-20T22:30:00Z');
    assert.equal(instant.toISOString().slice(0, 10), '2026-10-20');
    assert.equal(moscowDateKey(instant), '2026-10-21');
  });
});

describe('московский месяц', () => {
  it('месяц начинается в полночь первого числа по Москве', () => {
    assert.equal(moscowMonthStart(new Date('2026-10-15T10:00:00Z')).toISOString(), '2026-09-30T21:00:00.000Z');
    assert.equal(moscowMonthStart(new Date('2026-09-30T21:00:00Z')).toISOString(), '2026-09-30T21:00:00.000Z');
    assert.equal(moscowMonthStart(new Date('2026-09-30T20:59:59.999Z')).toISOString(), '2026-08-31T21:00:00.000Z');
  });

  it('конец месяца исключающий, декабрь переходит в январь', () => {
    assert.equal(moscowNextMonthStart(new Date('2026-10-15T10:00:00Z')).toISOString(), '2026-10-31T21:00:00.000Z');
    assert.equal(moscowNextMonthStart(new Date('2026-12-15T10:00:00Z')).toISOString(), '2026-12-31T21:00:00.000Z');
  });
});

describe('даты запросов', () => {
  it('корректная дата превращается в начало суток по Москве', () => {
    assert.equal(parseMoscowDate('2026-10-20')?.toISOString(), '2026-10-19T21:00:00.000Z');
  });

  it('несуществующие и неверно записанные даты отвергаются', () => {
    assert.equal(parseMoscowDate('2026-02-30'), null);
    assert.equal(parseMoscowDate('2026-13-01'), null);
    assert.equal(parseMoscowDate('20.10.2026'), null);
    assert.equal(parseMoscowDate('2026-10-2'), null);
  });

  it('високосный день существует только в високосный год', () => {
    assert.notEqual(parseMoscowDate('2028-02-29'), null);
    assert.equal(parseMoscowDate('2027-02-29'), null);
  });
});

describe('вывод времени', () => {
  it('время выводится со смещением +03:00', () => {
    assert.equal(toMoscowIso(new Date('2026-10-20T20:40:12.007Z')), '2026-10-20T23:40:12.007+03:00');
    assert.equal(toMoscowIso(new Date('2026-12-31T21:00:00Z')), '2027-01-01T00:00:00.000+03:00');
  });
});

describe('переходы месяца и года по Москве', () => {
  it('29 февраля високосного года есть, в обычном году после 28 февраля сразу март', () => {
    assert.equal(moscowNextMonthStart(new Date('2028-02-10T10:00:00Z')).toISOString(), '2028-02-29T21:00:00.000Z');
    assert.equal(moscowDayStart(new Date('2028-02-29T10:00:00Z')).toISOString(), '2028-02-28T21:00:00.000Z');
    assert.equal(moscowNextDayStart(new Date('2028-02-29T10:00:00Z')).toISOString(), '2028-02-29T21:00:00.000Z');
    assert.equal(moscowNextDayStart(new Date('2027-02-28T10:00:00Z')).toISOString(), '2027-02-28T21:00:00.000Z');
    assert.equal(moscowDateKey(new Date('2027-02-28T21:00:00Z')), '2027-03-01');
    assert.equal(moscowMonthStart(new Date('2027-03-01T00:30:00Z')).toISOString(), '2027-02-28T21:00:00.000Z');
  });

  it('новогодняя ночь: 21:00 UTC 31 декабря — уже январь следующего года по Москве', () => {
    const justBefore = new Date('2026-12-31T20:59:59.999Z');
    const newYear = new Date('2026-12-31T21:00:00.000Z');
    assert.equal(moscowDateKey(justBefore), '2026-12-31');
    assert.equal(moscowDateKey(newYear), '2027-01-01');
    assert.equal(moscowMonthStart(newYear).toISOString(), '2026-12-31T21:00:00.000Z');
    assert.equal(moscowNextMonthStart(newYear).toISOString(), '2027-01-31T21:00:00.000Z');
    assert.equal(moscowNextMonthStart(justBefore).toISOString(), '2026-12-31T21:00:00.000Z');
    assert.equal(moscowParts(new Date('2026-12-31T22:30:00Z')).year, 2027);
  });

  it('последний день месяца заканчивается там же, где начинается следующий', () => {
    for (const month of ['2026-01-31T12:00:00Z', '2026-04-30T12:00:00Z', '2026-12-31T12:00:00Z']) {
      const instant = new Date(month);
      assert.equal(moscowNextDayStart(instant).getTime(), moscowNextMonthStart(instant).getTime());
    }
  });
});
