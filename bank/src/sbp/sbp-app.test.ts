import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickDelay } from './sbp-app';

describe('задержка учебной СБП', () => {
  it('случайная задержка попадает в диапазон 1–3 секунды включительно', () => {
    let seenLow = Number.POSITIVE_INFINITY;
    let seenHigh = 0;
    for (let i = 0; i < 2000; i += 1) {
      const delay = pickDelay(1000, 3000);
      seenLow = Math.min(seenLow, delay);
      seenHigh = Math.max(seenHigh, delay);
    }
    assert.ok(seenLow >= 1000 && seenHigh <= 3000);
    assert.ok(seenHigh - seenLow > 1000);
  });

  it('верхняя граница включается', () => {
    assert.equal(pickDelay(1000, 3000, (_low, high) => high - 1), 3000);
    assert.equal(pickDelay(1000, 3000, (low) => low), 1000);
  });

  it('при равных границах задержка постоянная', () => {
    assert.equal(pickDelay(500, 500), 500);
    assert.equal(pickDelay(500, 100), 500);
    assert.equal(pickDelay(0, 0), 0);
  });
});
