import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BankClock } from './bank-clock';

describe('банковское время', () => {
  it('без сдвига совпадает с реальным', () => {
    const clock = new BankClock(() => 1_000_000);
    assert.equal(clock.now().getTime(), 1_000_000);
  });

  it('shiftTo ставит часы банка на нужный момент и они продолжают идти', () => {
    let real = 5_000_000;
    const clock = new BankClock(() => real);
    const target = new Date('2026-10-20T20:40:00Z');
    clock.shiftTo(target);
    assert.equal(clock.now().getTime(), target.getTime());
    real += 90_000;
    assert.equal(clock.now().getTime(), target.getTime() + 90_000);
  });

  it('reset возвращает реальное время', () => {
    const clock = new BankClock(() => 42, 1000);
    assert.equal(clock.now().getTime(), 1042);
    clock.reset();
    assert.equal(clock.now().getTime(), 42);
  });

  it('shiftTo возвращает смещение для сохранения', () => {
    const clock = new BankClock(() => 1000);
    assert.equal(clock.shiftTo(new Date(4000)), 3000);
    assert.equal(clock.getOffsetMs(), 3000);
  });
});
