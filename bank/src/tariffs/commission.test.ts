import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rubles } from '../accounts/money';
import { calculateCommission, calculateCommissionDroppingKopecks, remainingFreeVolume } from './commission';

const START = {
  freeMonthlyVolume: rubles(100_000),
  commissionRateBps: 100,
  commissionMin: rubles(30),
  commissionMax: rubles(1_500),
};

describe('комиссия по тарифу «Старт»', () => {
  it('в пределах бесплатного месячного объёма комиссии нет', () => {
    assert.equal(calculateCommission({ amount: rubles(1_000), monthlyVolumeBefore: 0n, tariff: START }), 0n);
    assert.equal(calculateCommission({ amount: rubles(100_000), monthlyVolumeBefore: 0n, tariff: START }), 0n);
  });

  it('перевод ровно до границы объёма бесплатный, на копейку больше — платный по минимуму', () => {
    const before = rubles(60_000);
    assert.equal(calculateCommission({ amount: rubles(40_000), monthlyVolumeBefore: before, tariff: START }), 0n);
    assert.equal(calculateCommission({ amount: rubles(40_000) + 1n, monthlyVolumeBefore: before, tariff: START }), rubles(30));
  });

  it('комиссия берётся только с части сверх бесплатного объёма', () => {
    const fee = calculateCommission({ amount: rubles(30_000), monthlyVolumeBefore: rubles(90_000), tariff: START });
    assert.equal(fee, rubles(200));
  });

  it('когда объём исчерпан, комиссия 1 % от всей суммы', () => {
    const fee = calculateCommission({ amount: rubles(50_000), monthlyVolumeBefore: rubles(100_000), tariff: START });
    assert.equal(fee, rubles(500));
  });

  it('минимум 30 ₽ действует на малые суммы', () => {
    assert.equal(calculateCommission({ amount: rubles(1_000), monthlyVolumeBefore: rubles(100_000), tariff: START }), rubles(30));
    assert.equal(calculateCommission({ amount: rubles(3_000), monthlyVolumeBefore: rubles(100_000), tariff: START }), rubles(30));
    assert.equal(calculateCommission({ amount: rubles(3_001), monthlyVolumeBefore: rubles(100_000), tariff: START }), 3_001n);
  });

  it('максимум 1 500 ₽ действует на крупные суммы', () => {
    assert.equal(calculateCommission({ amount: rubles(150_000), monthlyVolumeBefore: rubles(100_000), tariff: START }), rubles(1_500));
    assert.equal(calculateCommission({ amount: rubles(149_999), monthlyVolumeBefore: rubles(100_000), tariff: START }), 149_999n);
    assert.equal(calculateCommission({ amount: rubles(200_000), monthlyVolumeBefore: rubles(100_000), tariff: START }), rubles(1_500));
  });

  it('копейки округляются от половины вверх', () => {
    const amount = 305_050n;
    assert.equal(calculateCommission({ amount, monthlyVolumeBefore: rubles(100_000), tariff: START }), 3_051n);
    assert.equal(calculateCommission({ amount: 305_049n, monthlyVolumeBefore: rubles(100_000), tariff: START }), 3_050n);
  });

  it('нулевая ставка даёт нулевую комиссию только если минимум тоже нулевой', () => {
    const free = { ...START, commissionRateBps: 0, commissionMin: 0n };
    assert.equal(calculateCommission({ amount: rubles(500), monthlyVolumeBefore: rubles(100_000), tariff: free }), 0n);
  });

  it('остаток бесплатного объёма не уходит в минус', () => {
    assert.equal(remainingFreeVolume(rubles(100_000), rubles(30_000)), rubles(70_000));
    assert.equal(remainingFreeVolume(rubles(100_000), rubles(100_000)), 0n);
    assert.equal(remainingFreeVolume(rubles(100_000), rubles(120_000)), 0n);
  });

  it('вариант без копеек отбрасывает копейки комиссии, правильный округляет до копейки', () => {
    const input = { amount: rubles(4_567) + 89n, monthlyVolumeBefore: rubles(100_000), tariff: START };
    assert.equal(calculateCommission(input), 4_568n);
    assert.equal(calculateCommissionDroppingKopecks(input), 4_500n);
  });

  it('вариант без копеек совпадает с правильным там, где копеек нет или работают границы', () => {
    const whole = { amount: rubles(5_000), monthlyVolumeBefore: rubles(100_000), tariff: START };
    assert.equal(calculateCommissionDroppingKopecks(whole), calculateCommission(whole));
    const minimum = { amount: rubles(1_000), monthlyVolumeBefore: rubles(100_000), tariff: START };
    assert.equal(calculateCommissionDroppingKopecks(minimum), rubles(30));
    const maximum = { amount: rubles(200_000) + 55n, monthlyVolumeBefore: rubles(100_000), tariff: START };
    assert.equal(calculateCommissionDroppingKopecks(maximum), rubles(1_500));
    assert.equal(calculateCommissionDroppingKopecks({ amount: rubles(10), monthlyVolumeBefore: 0n, tariff: START }), 0n);
  });
});
