import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rubles } from '../accounts/money';
import { checkDailyLimit, effectiveDailyLimit } from './limits';

const LIMIT = rubles(150_000);

describe('суточный лимит переводов по телефону', () => {
  it('перевод ровно до лимита разрешён', () => {
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: 0n, amount: LIMIT }).allowed, true);
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: rubles(100_000), amount: rubles(50_000) }).allowed, true);
  });

  it('на копейку больше лимита — отказ', () => {
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: 0n, amount: LIMIT + 1n }).allowed, false);
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: rubles(100_000), amount: rubles(50_000) + 1n }).allowed, false);
  });

  it('когда лимит исчерпан, любой перевод отклоняется', () => {
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: LIMIT, amount: 1n }).allowed, false);
  });

  it('остаток лимита считается без отрицательных значений', () => {
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: rubles(40_000), amount: 1n }).remaining, rubles(110_000));
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: LIMIT, amount: 1n }).remaining, 0n);
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: LIMIT + 5n, amount: 1n }).remaining, 0n);
  });

  it('пенсионный лимит 50 000 ₽', () => {
    const pension = rubles(50_000);
    assert.equal(checkDailyLimit({ limit: pension, usedToday: 0n, amount: pension }).allowed, true);
    assert.equal(checkDailyLimit({ limit: pension, usedToday: 0n, amount: pension + 1n }).allowed, false);
  });

  it('личный лимит клиента заменяет лимит тарифа', () => {
    assert.equal(effectiveDailyLimit(LIMIT, rubles(10_000)), rubles(10_000));
    assert.equal(effectiveDailyLimit(LIMIT, 0n), 0n);
    assert.equal(effectiveDailyLimit(LIMIT, null), LIMIT);
  });

  it('строгая проверка отклоняет перевод ровно до лимита, а выключенная — нет', () => {
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: 0n, amount: LIMIT, strict: true }).allowed, false);
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: 0n, amount: LIMIT, strict: false }).allowed, true);
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: 0n, amount: LIMIT - 1n, strict: true }).allowed, true);
    assert.equal(checkDailyLimit({ limit: LIMIT, usedToday: rubles(100_000), amount: rubles(50_000), strict: true }).allowed, false);
  });
});
