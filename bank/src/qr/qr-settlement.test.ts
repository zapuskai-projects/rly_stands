import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { balanceDeltas } from '../accounts/postings-plan';
import { planQrPaymentPostings } from './qr-settlement';

const input = {
  payerAccountId: 'payer',
  merchantAccountId: 'merchant',
  incomeAccountId: 'income',
  paymentDescription: 'оплата',
  commissionDescription: 'комиссия',
};

describe('проводки оплаты по QR', () => {
  it('покупатель платит всю сумму магазину, магазин отдаёт комиссию в доходы банка', () => {
    const postings = planQrPaymentPostings({ ...input, amount: 123_450n, commission: 864n });
    assert.deepEqual(postings.map((posting) => [posting.debitAccountId, posting.creditAccountId, posting.amount, posting.kind]), [
      ['payer', 'merchant', 123_450n, 'TRANSFER'],
      ['merchant', 'income', 864n, 'FEE'],
    ]);
  });

  it('остатки сходятся: покупатель −сумма, магазин +сумма−комиссия, банк +комиссия', () => {
    const deltas = balanceDeltas(planQrPaymentPostings({ ...input, amount: 123_450n, commission: 864n }));
    assert.equal(deltas.get('payer'), -123_450n);
    assert.equal(deltas.get('merchant'), 122_586n);
    assert.equal(deltas.get('income'), 864n);
  });

  it('при нулевой комиссии проводка комиссии не создаётся', () => {
    const postings = planQrPaymentPostings({ ...input, amount: 71n, commission: 0n });
    assert.equal(postings.length, 1);
  });
});
