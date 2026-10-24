import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rubles } from '../accounts/money';
import { checkDailyLimit } from '../tariffs/limits';
import { limitDefectMarks, type LimitDefectFlags } from './limit-defects';

const LIMIT = rubles(150_000);

function decider(usedByMoscowDay: bigint, usedByUtcDay: bigint, amount: bigint) {
  return (flags: LimitDefectFlags) =>
    checkDailyLimit({ limit: flags.templateSkip ? LIMIT * 1_000_000n : LIMIT, usedToday: flags.utcDay ? usedByUtcDay : usedByMoscowDay, amount, strict: flags.boundary }).allowed
      ? null
      : 'DAILY_LIMIT_EXCEEDED';
}

const off: LimitDefectFlags = { boundary: false, utcDay: false };

describe('пометки сбоев лимита', () => {
  it('выключенные сбои ничего не помечают', () => {
    assert.deepEqual(limitDefectMarks(decider(0n, 0n, LIMIT), off, {}), []);
    assert.deepEqual(limitDefectMarks(decider(0n, rubles(200_000), rubles(1_000)), off, {}), []);
  });

  it('граница лимита помечается только когда перевод пришёлся ровно на лимит', () => {
    const on = { ...off, boundary: true };
    const hit = limitDefectMarks(decider(0n, 0n, LIMIT), on, { limit: 1 });
    assert.deepEqual(hit, [{ code: 'limit-boundary', details: { expected: 'ACCEPTED', actual: 'DAILY_LIMIT_EXCEEDED', limit: 1 } }]);
    assert.deepEqual(limitDefectMarks(decider(0n, 0n, LIMIT - 1n), on, {}), []);
    assert.deepEqual(limitDefectMarks(decider(0n, 0n, LIMIT + 1n), on, {}), []);
  });

  it('сутки по UTC помечаются, когда решение меняется в любую сторону, и не помечаются, когда не меняется', () => {
    const on = { ...off, utcDay: true };
    const rejectedWrongly = limitDefectMarks(decider(0n, rubles(140_000), rubles(140_000)), on, {});
    assert.deepEqual(rejectedWrongly.map((mark) => [mark.code, mark.details.expected, mark.details.actual]), [['daily-limit-utc', 'ACCEPTED', 'DAILY_LIMIT_EXCEEDED']]);
    const acceptedWrongly = limitDefectMarks(decider(rubles(140_000), 0n, rubles(140_000)), on, {});
    assert.deepEqual(acceptedWrongly.map((mark) => [mark.code, mark.details.expected, mark.details.actual]), [['daily-limit-utc', 'DAILY_LIMIT_EXCEEDED', 'ACCEPTED']]);
    assert.deepEqual(limitDefectMarks(decider(rubles(1_000), rubles(2_000), rubles(1_000)), on, {}), []);
    assert.deepEqual(limitDefectMarks(decider(rubles(150_000), rubles(160_000), rubles(1_000)), on, {}), []);
  });

  it('при двух включённых сбоях пометка ставится тому, без которого решение было бы другим', () => {
    const both = { boundary: true, utcDay: true };
    const onlyBoundary = limitDefectMarks(decider(0n, 0n, LIMIT), both, {});
    assert.deepEqual(onlyBoundary.map((mark) => mark.code), ['limit-boundary']);
    const onlyUtc = limitDefectMarks(decider(0n, rubles(140_000), rubles(140_000)), both, {});
    assert.deepEqual(onlyUtc.map((mark) => mark.code), ['daily-limit-utc']);
  });

  it('перевод по шаблону мимо лимита помечается, когда лимит был бы превышен, и не помечается в остальных случаях', () => {
    const on = { ...off, templateSkip: true };
    const skipped = limitDefectMarks(decider(rubles(149_000), rubles(149_000), rubles(2_000)), on, {});
    assert.deepEqual(skipped.map((mark) => [mark.code, mark.details.expected, mark.details.actual]), [['template-skips-limit', 'DAILY_LIMIT_EXCEEDED', 'ACCEPTED']]);
    assert.deepEqual(limitDefectMarks(decider(0n, 0n, rubles(1_000)), on, {}), []);
  });
});
