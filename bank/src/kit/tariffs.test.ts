import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rubles } from '../accounts/money';
import { BankError } from '../shared/errors';
import { mergeTariff, tariffFact, TARIFF_DEFAULTS } from './tariffs';

const START = TARIFF_DEFAULTS[0] as (typeof TARIFF_DEFAULTS)[number];

describe('настройки тарифа из сценария', () => {
  it('частичная правка меняет только названные поля', () => {
    const merged = mergeTariff(START, { code: 'START', dailyLimitKop: 1_000_000, rateBps: 200 });
    assert.equal(merged.dailyPhoneLimit, 1_000_000n);
    assert.equal(merged.commissionRateBps, 200);
    assert.equal(merged.freeMonthlyVolume, START.freeMonthlyVolume);
    assert.equal(merged.commissionMin, START.commissionMin);
    assert.equal(merged.commissionMax, START.commissionMax);
  });

  it('минимум комиссии больше максимума отвергается, в том числе при правке одного поля', () => {
    assert.throws(() => mergeTariff(START, { code: 'START', minKop: Number(rubles(2_000)) }), (error) => error instanceof BankError && error.code === 'INVALID_TARIFF');
    assert.throws(() => mergeTariff(START, { code: 'START', maxKop: 100 }), (error) => error instanceof BankError && error.status === 422);
    assert.equal(mergeTariff(START, { code: 'START', minKop: Number(rubles(1_500)) }).commissionMin, rubles(1_500));
  });

  it('в ответе суммы целые копейки, поля названы как в договоре', () => {
    assert.deepEqual(tariffFact(START), {
      code: 'START',
      name: 'Старт',
      dailyLimitKop: 15_000_000,
      freeMonthlyKop: 10_000_000,
      rateBps: 100,
      minKop: 3_000,
      maxKop: 150_000,
    });
  });

  it('значения по умолчанию совпадают с тарифами из миграции', () => {
    assert.deepEqual(TARIFF_DEFAULTS.map((tariff) => tariff.code), ['START', 'PENSION']);
    assert.equal(TARIFF_DEFAULTS[1]?.dailyPhoneLimit, rubles(50_000));
  });
});
