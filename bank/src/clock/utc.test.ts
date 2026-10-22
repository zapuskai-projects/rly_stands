import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { moscowDayStart } from './moscow';
import { utcDayStart, utcNextDayStart } from './utc';

describe('сутки по UTC', () => {
  it('границы суток — полночь UTC', () => {
    const instant = new Date('2026-10-20T20:40:00.123Z');
    assert.equal(utcDayStart(instant).toISOString(), '2026-10-20T00:00:00.000Z');
    assert.equal(utcNextDayStart(instant).toISOString(), '2026-10-21T00:00:00.000Z');
  });

  it('с 00:00 до 03:00 по Москве сутки по UTC ещё вчерашние, с 03:00 — уже сегодняшние', () => {
    const night = new Date('2026-10-20T21:40:00Z');
    assert.equal(moscowDayStart(night).toISOString(), '2026-10-20T21:00:00.000Z');
    assert.equal(utcDayStart(night).toISOString(), '2026-10-20T00:00:00.000Z');
    const morning = new Date('2026-10-21T00:30:00Z');
    assert.equal(utcDayStart(morning).toISOString(), '2026-10-21T00:00:00.000Z');
    assert.equal(moscowDayStart(morning).toISOString(), '2026-10-20T21:00:00.000Z');
  });
});

describe('переходы месяца и года по UTC', () => {
  it('новогодняя ночь по Москве ещё принадлежит прошлому году по UTC', () => {
    const instant = new Date('2026-12-31T21:30:00Z');
    assert.equal(utcDayStart(instant).toISOString(), '2026-12-31T00:00:00.000Z');
    assert.equal(utcNextDayStart(instant).toISOString(), '2027-01-01T00:00:00.000Z');
    assert.equal(moscowDayStart(instant).toISOString(), '2026-12-31T21:00:00.000Z');
  });

  it('конец февраля: високосный год и обычный', () => {
    assert.equal(utcNextDayStart(new Date('2028-02-28T10:00:00Z')).toISOString(), '2028-02-29T00:00:00.000Z');
    assert.equal(utcNextDayStart(new Date('2028-02-29T10:00:00Z')).toISOString(), '2028-03-01T00:00:00.000Z');
    assert.equal(utcNextDayStart(new Date('2027-02-28T10:00:00Z')).toISOString(), '2027-03-01T00:00:00.000Z');
  });
});
