import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isValidAccountNumber } from '../accounts/account-number';
import { BANK } from '../shared/bank-identity';
import { buildAccountNumber } from '../accounts/account-number';
import { technicalAccountSerial, technicalClientNumber, technicalPhone } from './check-client';

describe('технический клиент проверок: номера', () => {
  it('телефон из отдельного диапазона, не пересекается с персонами и банками-партнёрами', () => {
    assert.equal(technicalPhone(1), '+79009990001');
    assert.equal(technicalPhone(9999), '+79009999999');
    assert.match(technicalPhone(42), /^\+79[0-9]{9}$/);
    for (const other of ['+79001110001', '+79001110006', '+79002220001']) assert.notEqual(technicalPhone(1).slice(0, 8), other.slice(0, 8));
  });

  it('номер клиента не совпадает с номерами персон (10000001…) и сортируется по порядку', () => {
    assert.equal(technicalClientNumber(1), '90000001');
    assert.ok(technicalClientNumber(2) > technicalClientNumber(1));
    assert.ok(technicalClientNumber(1) > '10000099');
  });

  it('счёт получает верный номер и порядковый номер вне диапазона персон', () => {
    for (const index of [1, 500, 9999]) {
      const serial = technicalAccountSerial(index);
      assert.ok(serial >= 9_000_000 && serial <= 9_999_999);
      assert.ok(isValidAccountNumber(BANK.bik, buildAccountNumber(BANK.bik, { balanceAccount: '40817', serial })));
    }
    assert.notEqual(technicalAccountSerial(1), technicalAccountSerial(2));
  });
});
