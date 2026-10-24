import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hiddenOperationTypes, isRelease, parseRelease, releaseAtLeast } from './release';

describe('релизы банка', () => {
  it('релиз доступен, когда текущий не ниже требуемого', () => {
    assert.equal(releaseAtLeast('1.0', '1.0'), true);
    assert.equal(releaseAtLeast('1.0', '1.1'), false);
    assert.equal(releaseAtLeast('1.1', '1.0'), true);
    assert.equal(releaseAtLeast('1.1', '1.2'), false);
    assert.equal(releaseAtLeast('1.2', '1.1'), true);
  });

  it('неизвестный релиз не принимается', () => {
    assert.equal(isRelease('1.1'), true);
    assert.equal(isRelease('2.0'), false);
    assert.equal(isRelease(1.1), false);
    assert.throws(() => parseRelease('9.9', 'тест'), /9\.9/);
  });
});

describe('виды операций следующих релизов', () => {
  it('до 1.2 оплата и возврат по QR скрыты, с 1.2 видны', () => {
    assert.deepEqual(hiddenOperationTypes('1.0'), ['QR_PAYMENT', 'QR_REFUND']);
    assert.deepEqual(hiddenOperationTypes('1.1'), ['QR_PAYMENT', 'QR_REFUND']);
    assert.deepEqual(hiddenOperationTypes('1.2'), []);
  });
});
