import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { payLabel, qrBlockReason } from './qr-labels';

describe('оплата по QR: подписи', () => {
  it('ждущий оплаты QR не блокирует кнопку', () => {
    assert.equal(qrBlockReason('CREATED'), null);
  });

  it('оплаченный, просроченный и отменённый называют причину', () => {
    assert.equal(qrBlockReason('PAID'), 'QR-код уже оплачен');
    assert.equal(qrBlockReason('REFUNDED'), 'QR-код уже оплачен');
    assert.equal(qrBlockReason('EXPIRED'), 'Срок действия QR-кода истёк');
    assert.equal(qrBlockReason('CANCELLED'), 'Магазин отменил QR-код');
  });

  it('кнопка называет сумму, целые рубли без копеек', () => {
    assert.equal(payLabel(null), 'Оплатить');
    assert.match(payLabel(150000), /^Оплатить 1\s500 ₽$/);
    assert.match(payLabel(123450), /^Оплатить 1\s234,50\s₽$/);
  });
});
