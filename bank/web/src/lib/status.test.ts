import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TYPE_LABEL, typeFilterOptions } from './status';

describe('виды операций в фильтрах', () => {
  it('оплата по QR появляется в фильтре с релиза 1.2', () => {
    assert.deepEqual(typeFilterOptions('1.0'), ['OWN_TRANSFER', 'PHONE_TRANSFER']);
    assert.deepEqual(typeFilterOptions('1.1'), ['OWN_TRANSFER', 'PHONE_TRANSFER']);
    assert.deepEqual(typeFilterOptions('1.2'), ['OWN_TRANSFER', 'PHONE_TRANSFER', 'QR_PAYMENT', 'QR_REFUND']);
    assert.deepEqual(typeFilterOptions(null), ['OWN_TRANSFER', 'PHONE_TRANSFER']);
  });

  it('у каждого вида есть подпись', () => {
    assert.equal(TYPE_LABEL.QR_PAYMENT, 'Оплата по QR');
  });
});
