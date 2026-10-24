import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildQrPayload, cancelRefusal, effectiveQrStatus, merchantCommission, paymentDecision, paymentRefusal, parseQrPayload, qrExpiresAt, type QrState } from './qr-rules';

const ID = '3f2b7c1e-5d4a-4c8b-9e61-0a1b2c3d4e5f';
const NOW = new Date('2026-10-24T09:00:00Z');
const LATER = new Date(NOW.getTime() + 600_000);

const open = (patch: Partial<QrState> = {}): QrState => ({ status: 'CREATED', expiresAt: LATER, pendingOperationId: null, ...patch });

describe('содержимое QR-кода', () => {
  it('собирается и разбирается обратно', () => {
    assert.equal(buildQrPayload(ID), `zbqr://pay?id=${ID}`);
    assert.equal(parseQrPayload(buildQrPayload(ID)), ID);
  });

  it('пробелы по краям и регистр не мешают', () => {
    assert.equal(parseQrPayload(`  zbqr://pay?id=${ID.toUpperCase()}\n`), ID);
  });

  it('чужое содержимое не принимается', () => {
    for (const text of ['', 'https://example.com', 'zbqr://pay?id=123', `zbqr://refund?id=${ID}`, `zbqr://pay?id=${ID}&x=1`, `zbqr://pay?id=${ID}0`]) {
      assert.equal(parseQrPayload(text), null, text);
    }
  });
});

describe('срок действия', () => {
  it('отсчитывается от создания', () => {
    assert.equal(qrExpiresAt(NOW, 600).getTime(), LATER.getTime());
  });

  it('в момент окончания QR уже просрочен, за секунду до — действует', () => {
    assert.equal(effectiveQrStatus(open(), new Date(LATER.getTime() - 1000)), 'CREATED');
    assert.equal(effectiveQrStatus(open(), LATER), 'EXPIRED');
  });

  it('QR с идущей оплатой не считается просроченным', () => {
    assert.equal(effectiveQrStatus(open({ pendingOperationId: 'op' }), new Date(LATER.getTime() + 5000)), 'CREATED');
  });

  it('оплаченный и отменённый QR остаются такими же после срока', () => {
    const after = new Date(LATER.getTime() + 5000);
    assert.equal(effectiveQrStatus(open({ status: 'PAID' }), after), 'PAID');
    assert.equal(effectiveQrStatus(open({ status: 'CANCELLED' }), after), 'CANCELLED');
  });
});

describe('можно ли платить', () => {
  it('открытый QR принимается к оплате', () => {
    assert.equal(paymentRefusal(open(), NOW), null);
  });

  it('просроченный, отменённый и оплаченный отказывают своими кодами', () => {
    assert.equal(paymentRefusal(open(), LATER)?.code, 'QR_EXPIRED');
    assert.equal(paymentRefusal(open({ status: 'CANCELLED' }), NOW)?.code, 'QR_CANCELLED');
    for (const status of ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const) {
      assert.equal(paymentRefusal(open({ status }), NOW)?.code, 'QR_ALREADY_PAID', status);
    }
  });

  it('пока идёт чужая оплата, вторая отклоняется', () => {
    assert.equal(paymentRefusal(open({ pendingOperationId: 'op' }), NOW)?.code, 'QR_ALREADY_PAID');
  });

  it('QR, переведённый в EXPIRED, отказывает как просроченный', () => {
    assert.equal(paymentRefusal(open({ status: 'EXPIRED' }), NOW)?.code, 'QR_EXPIRED');
  });
});

describe('можно ли отменить', () => {
  it('неоплаченный отменяется, повторная отмена не ошибка', () => {
    assert.equal(cancelRefusal(open(), NOW), null);
    assert.equal(cancelRefusal(open({ status: 'CANCELLED' }), NOW), null);
  });

  it('оплаченный, просроченный и оплачиваемый отменить нельзя', () => {
    assert.equal(cancelRefusal(open({ status: 'PAID' }), NOW)?.code, 'QR_ALREADY_PAID');
    assert.equal(cancelRefusal(open(), LATER)?.code, 'QR_EXPIRED');
    assert.equal(cancelRefusal(open({ pendingOperationId: 'op' }), NOW)?.code, 'QR_ALREADY_PAID');
  });
});

describe('комиссия магазина', () => {
  it('0,7 % с округлением до копейки по правилам половины вверх', () => {
    assert.equal(merchantCommission(100_000n, 70), 700n);
    assert.equal(merchantCommission(123_450n, 70), 864n);
    assert.equal(merchantCommission(143n, 70), 1n);
    assert.equal(merchantCommission(72n, 70), 1n);
    assert.equal(merchantCommission(71n, 70), 0n);
  });

  it('на крупной сумме не теряет копейки', () => {
    assert.equal(merchantCommission(99_999_999_900n, 70), 699_999_999n);
  });
});

describe('решение об оплате и сбои', () => {
  const none = { doublePayment: false, expiredAccepted: false };

  it('без сбоев решение совпадает с отказом по правилам, пометки нет', () => {
    assert.deepEqual(paymentDecision(open(), NOW, none), { refusal: null, defect: null });
    assert.equal(paymentDecision(open({ status: 'PAID' }), NOW, none).refusal?.code, 'QR_ALREADY_PAID');
    assert.equal(paymentDecision(open(), LATER, none).refusal?.code, 'QR_EXPIRED');
  });

  it('повторная оплата принимается только при включённом сбое и только вместо отказа «уже оплачен»', () => {
    const on = { ...none, doublePayment: true };
    assert.deepEqual(paymentDecision(open({ status: 'PAID' }), NOW, on), { refusal: null, defect: { code: 'qr-double-payment', expected: 'QR_ALREADY_PAID' } });
    assert.deepEqual(paymentDecision(open({ pendingOperationId: 'op' }), NOW, on).defect?.code, 'qr-double-payment');
    assert.deepEqual(paymentDecision(open(), NOW, on), { refusal: null, defect: null });
    assert.equal(paymentDecision(open({ status: 'CANCELLED' }), NOW, on).refusal?.code, 'QR_CANCELLED');
    assert.equal(paymentDecision(open(), LATER, on).refusal?.code, 'QR_EXPIRED');
  });

  it('просроченный QR принимается только при включённом сбое, отменённый и оплаченный — нет', () => {
    const on = { ...none, expiredAccepted: true };
    assert.deepEqual(paymentDecision(open(), LATER, on), { refusal: null, defect: { code: 'qr-expired-accepted', expected: 'QR_EXPIRED' } });
    assert.deepEqual(paymentDecision(open({ status: 'EXPIRED' }), NOW, on).defect?.code, 'qr-expired-accepted');
    assert.equal(paymentDecision(open({ status: 'CANCELLED' }), LATER, on).refusal?.code, 'QR_CANCELLED');
    assert.equal(paymentDecision(open({ status: 'PAID' }), LATER, on).refusal?.code, 'QR_ALREADY_PAID');
  });
});
