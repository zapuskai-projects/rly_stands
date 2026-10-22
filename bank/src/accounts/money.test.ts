import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampKopecks, formatRubles, fromApiAmount, mulDivRoundHalfUp, rubles, toApiAmount } from './money';

describe('деньги в копейках', () => {
  it('рубли переводятся в копейки без потерь', () => {
    assert.equal(rubles(1500), 150000n);
    assert.equal(rubles(0), 0n);
  });

  it('дробные рубли отвергаются', () => {
    assert.throws(() => rubles(1.5), RangeError);
  });

  it('формат рублей с разрядами и копейками', () => {
    assert.equal(formatRubles(0n), '0,00 ₽');
    assert.equal(formatRubles(5n), '0,05 ₽');
    assert.equal(formatRubles(150000n), '1 500,00 ₽');
    assert.equal(formatRubles(15000000n), '150 000,00 ₽');
    assert.equal(formatRubles(123456789n), '1 234 567,89 ₽');
    assert.equal(formatRubles(-250n), '−2,50 ₽');
  });

  it('округление половины вверх', () => {
    assert.equal(mulDivRoundHalfUp(150n, 1n, 100n), 2n);
    assert.equal(mulDivRoundHalfUp(149n, 1n, 100n), 1n);
    assert.equal(mulDivRoundHalfUp(50n, 1n, 100n), 1n);
    assert.equal(mulDivRoundHalfUp(49n, 1n, 100n), 0n);
    assert.equal(mulDivRoundHalfUp(1050n, 100n, 10000n), 11n);
    assert.equal(mulDivRoundHalfUp(1049n, 100n, 10000n), 10n);
  });

  it('округление не теряет копейки на больших суммах', () => {
    assert.equal(mulDivRoundHalfUp(999999999999n, 100n, 10000n), 10000000000n);
  });

  it('отрицательные значения и нулевой делитель отвергаются', () => {
    assert.throws(() => mulDivRoundHalfUp(-1n, 1n, 100n), RangeError);
    assert.throws(() => mulDivRoundHalfUp(1n, 1n, 0n), RangeError);
  });

  it('ограничение значения диапазоном', () => {
    assert.equal(clampKopecks(10n, 30n, 100n), 30n);
    assert.equal(clampKopecks(500n, 30n, 100n), 100n);
    assert.equal(clampKopecks(60n, 30n, 100n), 60n);
    assert.equal(clampKopecks(30n, 30n, 100n), 30n);
    assert.equal(clampKopecks(100n, 30n, 100n), 100n);
    assert.throws(() => clampKopecks(1n, 10n, 5n), RangeError);
  });

  it('обмен с JSON', () => {
    assert.equal(toApiAmount(150000n), 150000);
    assert.equal(fromApiAmount(150000), 150000n);
    assert.throws(() => toApiAmount(2n ** 60n), RangeError);
    assert.throws(() => fromApiAmount(1.5), RangeError);
    assert.throws(() => fromApiAmount(Number.NaN), RangeError);
  });
});
