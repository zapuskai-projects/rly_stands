import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hashTransferCommand, type TransferCommand } from './transfer-command';

const phone: TransferCommand = {
  type: 'PHONE_TRANSFER',
  fromAccount: '40817810800000001000',
  recipientPhone: '+79001110002',
  recipientBankCode: 'ZAPUSK',
  amount: 150000n,
  comment: null,
};

describe('отпечаток запроса перевода', () => {
  it('одинаковые запросы дают одинаковый отпечаток', () => {
    assert.equal(hashTransferCommand(phone), hashTransferCommand({ ...phone }));
  });

  it('любое изменение поля меняет отпечаток', () => {
    const base = hashTransferCommand(phone);
    assert.notEqual(base, hashTransferCommand({ ...phone, amount: 150001n }));
    assert.notEqual(base, hashTransferCommand({ ...phone, recipientPhone: '+79001110003' }));
    assert.notEqual(base, hashTransferCommand({ ...phone, recipientBankCode: 'KEDR' }));
    assert.notEqual(base, hashTransferCommand({ ...phone, comment: 'обед' }));
    assert.notEqual(base, hashTransferCommand({ ...phone, fromAccount: '40817810100000001001' }));
  });

  it('виды перевода не смешиваются', () => {
    const own: TransferCommand = {
      type: 'OWN_TRANSFER',
      fromAccount: phone.fromAccount,
      toAccount: '40817810100000001001',
      amount: 150000n,
      comment: null,
    };
    assert.notEqual(hashTransferCommand(own), hashTransferCommand(phone));
  });

  it('отсутствие комментария и пустой комментарий равнозначны', () => {
    assert.equal(hashTransferCommand({ ...phone, comment: null }), hashTransferCommand({ ...phone, comment: '' }));
  });
});
