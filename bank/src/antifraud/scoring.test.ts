import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rubles } from '../accounts/money';
import { decideByScore, describeRule, isAboveUsual, isNight, scorePayment, type PaymentFacts } from './scoring';

const DAY = new Date('2026-10-20T09:00:00Z');
const NIGHT = new Date('2026-10-20T20:40:00Z');

const quiet: PaymentFacts = { recipientKnown: true, priorTransfers: { count: 4, totalAmount: rubles(4_000) }, priorInLastHour: 0 };

describe('оценка перевода антифродом', () => {
  it('спокойный перевод набирает ноль', () => {
    assert.deepEqual(scorePayment({ createdAt: DAY, amount: rubles(1_000), facts: quiet }), { score: 0, rules: [] });
  });

  it('новый получатель — 30', () => {
    const result = scorePayment({ createdAt: DAY, amount: rubles(1_000), facts: { ...quiet, recipientKnown: false } });
    assert.deepEqual(result.rules, [{ code: 'NEW_RECIPIENT', points: 30 }]);
    assert.equal(result.score, 30);
  });

  it('ночь с 23:00 до 06:00 по Москве — 25, границы включают 23:00 и исключают 06:00', () => {
    assert.equal(isNight(new Date('2026-10-20T19:59:59.999Z')), false);
    assert.equal(isNight(new Date('2026-10-20T20:00:00.000Z')), true);
    assert.equal(isNight(new Date('2026-10-21T02:59:59.999Z')), true);
    assert.equal(isNight(new Date('2026-10-21T03:00:00.000Z')), false);
    assert.equal(scorePayment({ createdAt: NIGHT, amount: rubles(1_000), facts: quiet }).score, 25);
  });

  it('сумма больше обычной в 3 раза — 17, ровно в 3 раза ещё обычная', () => {
    const prior = { count: 4, totalAmount: rubles(4_000) };
    assert.equal(isAboveUsual(rubles(3_000), prior), false);
    assert.equal(isAboveUsual(rubles(3_000) + 1n, prior), true);
    assert.equal(scorePayment({ createdAt: DAY, amount: rubles(3_001), facts: quiet }).score, 17);
  });

  it('обычная сумма считается средней по прежним переводам без округления', () => {
    const prior = { count: 3, totalAmount: 1_000n };
    assert.equal(isAboveUsual(1_000n, prior), false);
    assert.equal(isAboveUsual(1_001n, prior), true);
  });

  it('у клиента без переводов любая сумма выше обычной', () => {
    assert.equal(isAboveUsual(1n, { count: 0, totalAmount: 0n }), true);
  });

  it('больше 5 переводов за час — 20: шестой по счёту уже попадает', () => {
    assert.equal(scorePayment({ createdAt: DAY, amount: rubles(1_000), facts: { ...quiet, priorInLastHour: 4 } }).score, 0);
    assert.equal(scorePayment({ createdAt: DAY, amount: rubles(1_000), facts: { ...quiet, priorInLastHour: 5 } }).score, 20);
  });

  it('очки складываются, максимум 92', () => {
    const all = scorePayment({
      createdAt: NIGHT,
      amount: rubles(100_000),
      facts: { recipientKnown: false, priorTransfers: { count: 2, totalAmount: rubles(2_000) }, priorInLastHour: 7 },
    });
    assert.equal(all.score, 92);
    assert.deepEqual(all.rules.map((rule) => rule.code), ['NEW_RECIPIENT', 'NIGHT_TIME', 'AMOUNT_ABOVE_USUAL', 'HIGH_FREQUENCY']);
  });

  it('ночной перевод новому получателю без истории уходит на проверку', () => {
    const first = scorePayment({
      createdAt: NIGHT,
      amount: rubles(5_000),
      facts: { recipientKnown: false, priorTransfers: { count: 0, totalAmount: 0n }, priorInLastHour: 0 },
    });
    assert.equal(first.score, 72);
  });

  it('ночной перевод новому получателю с историей остаётся ниже порога проверки', () => {
    const withHistory = scorePayment({ createdAt: NIGHT, amount: rubles(1_000), facts: { ...quiet, recipientKnown: false } });
    assert.equal(withHistory.score, 55);
    assert.equal(decideByScore(withHistory.score, { review: 70, reject: 90 }), 'APPROVE');
  });
});

describe('решение по порогам', () => {
  const thresholds = { review: 70, reject: 90 };

  it('границы порогов включают значение порога', () => {
    assert.equal(decideByScore(69, thresholds), 'APPROVE');
    assert.equal(decideByScore(70, thresholds), 'REVIEW');
    assert.equal(decideByScore(89, thresholds), 'REVIEW');
    assert.equal(decideByScore(90, thresholds), 'REJECT');
    assert.equal(decideByScore(92, thresholds), 'REJECT');
  });

  it('пороги настраиваются', () => {
    assert.equal(decideByScore(30, { review: 30, reject: 50 }), 'REVIEW');
    assert.equal(decideByScore(50, { review: 30, reject: 50 }), 'REJECT');
    assert.equal(decideByScore(0, { review: 1, reject: 100 }), 'APPROVE');
  });

  it('при равных порогах значение порога отклоняется', () => {
    assert.equal(decideByScore(60, { review: 60, reject: 60 }), 'REJECT');
  });

  it('у правил есть понятные описания', () => {
    assert.match(describeRule('NEW_RECIPIENT'), /Новый получатель/);
    assert.equal(describeRule('UNKNOWN'), 'UNKNOWN');
  });
});
