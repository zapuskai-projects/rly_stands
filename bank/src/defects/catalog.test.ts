import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFECT_CODES, isDefectCode, NO_DEFECTS, parseDefectCodes } from './catalog';

describe('каталог сбоев сценария', () => {
  it('в каталоге двенадцать кодов', () => {
    assert.deepEqual([...DEFECT_CODES].sort(), [
      'autopay-no-retry',
      'commission-rounding',
      'daily-limit-utc',
      'events.duplicate-delivery',
      'idempotency-double-debit',
      'kafka-amount-mismatch',
      'limit-boundary',
      'notify-before-complete',
      'regression-own-transfer-fee',
      'sbp-timeout-stuck',
      'template-ignores-amount',
      'template-skips-limit',
    ]);
  });

  it('неизвестные коды отбрасываются, повторы схлопываются', () => {
    const parsed = parseDefectCodes(['limit-boundary', 'нет-такого', 'limit-boundary', 'commission-rounding']);
    assert.deepEqual([...parsed].sort(), ['commission-rounding', 'limit-boundary']);
    assert.equal(isDefectCode('нет-такого'), false);
    assert.equal(isDefectCode('sbp-timeout-stuck'), true);
    assert.equal(isDefectCode('events.duplicate-delivery'), true);
  });

  it('без списка не включено ничего', () => {
    assert.equal(parseDefectCodes([]).size, 0);
    assert.equal(NO_DEFECTS.size, 0);
  });
});
