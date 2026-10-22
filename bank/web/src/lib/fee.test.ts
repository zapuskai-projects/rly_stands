import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { previewFee } from './fee';

const tariff = { commissionRateBps: 100, commissionMin: 3000, commissionMax: 150000 };

describe('комиссия на форме перевода', () => {
  it('внутри банка комиссии нет', () => {
    assert.equal(previewFee({ amount: 99_000_000, route: 'INTERNAL', freeRemaining: 0, tariff }), 0);
  });

  it('в другой банк в пределах бесплатной квоты — без комиссии', () => {
    assert.equal(previewFee({ amount: 10_000_000, route: 'SBP', freeRemaining: 10_000_000, tariff }), 0);
  });

  it('с части сверх квоты 1 %, минимум 30 ₽, максимум 1 500 ₽', () => {
    assert.equal(previewFee({ amount: 3_000_000, route: 'SBP', freeRemaining: 1_000_000, tariff }), 20_000);
    assert.equal(previewFee({ amount: 100_000, route: 'SBP', freeRemaining: 0, tariff }), 3_000);
    assert.equal(previewFee({ amount: 20_000_000, route: 'SBP', freeRemaining: 0, tariff }), 150_000);
  });

  it('копейки округляются от половины вверх, как на сервере', () => {
    assert.equal(previewFee({ amount: 305_050, route: 'SBP', freeRemaining: 0, tariff }), 3_051);
    assert.equal(previewFee({ amount: 305_049, route: 'SBP', freeRemaining: 0, tariff }), 3_050);
  });
});
