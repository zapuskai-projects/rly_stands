import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAccountNumber, calculateAccountKey, isValidAccountNumber } from './account-number';

const BIK = '044500950';

describe('номер счёта с ключом по БИК', () => {
  it('собранный номер состоит из 20 цифр и проходит проверку', () => {
    const number = buildAccountNumber(BIK, { balanceAccount: '40817', serial: 1000 });
    assert.match(number, /^[0-9]{20}$/);
    assert.equal(isValidAccountNumber(BIK, number), true);
  });

  it('структура номера: балансовый счёт, валюта, ключ, филиал, порядковый номер', () => {
    const number = buildAccountNumber(BIK, { balanceAccount: '40817', serial: 42 });
    assert.equal(number.slice(0, 5), '40817');
    assert.equal(number.slice(5, 8), '810');
    assert.equal(number.slice(9, 13), '0000');
    assert.equal(number.slice(13), '0000042');
  });

  it('ключ совпадает с рассчитанным отдельно', () => {
    const number = buildAccountNumber(BIK, { balanceAccount: '40802', serial: 7 });
    assert.equal(Number(number[8]), calculateAccountKey(BIK, number));
  });

  it('любая замена цифры ломает проверку', () => {
    const number = buildAccountNumber(BIK, { balanceAccount: '40817', serial: 1000 });
    for (let position = 0; position < 20; position += 1) {
      const digit = Number(number[position]);
      const broken = `${number.slice(0, position)}${(digit + 1) % 10}${number.slice(position + 1)}`;
      assert.equal(isValidAccountNumber(BIK, broken), false, `позиция ${position}`);
    }
  });

  it('номер от другого БИК не проходит проверку', () => {
    const number = buildAccountNumber(BIK, { balanceAccount: '40817', serial: 1000 });
    assert.equal(isValidAccountNumber('044500951', number), false);
  });

  it('известный корреспондентский счёт проходит проверку по условному номеру', () => {
    assert.equal(isValidAccountNumber('044525225', '30101810400000000225'), true);
    assert.equal(isValidAccountNumber('044525225', '30101810500000000225'), false);
  });

  it('неверная длина и не цифры не проходят', () => {
    assert.equal(isValidAccountNumber(BIK, '4081781000000000100'), false);
    assert.equal(isValidAccountNumber(BIK, '4081781000000000100A'), false);
    assert.equal(isValidAccountNumber('04450095', '40817810000000001000'), false);
  });

  it('некорректные части отвергаются при сборке', () => {
    assert.throws(() => buildAccountNumber(BIK, { balanceAccount: '4081', serial: 1 }), RangeError);
    assert.throws(() => buildAccountNumber(BIK, { balanceAccount: '40817', serial: -1 }), RangeError);
    assert.throws(() => buildAccountNumber(BIK, { balanceAccount: '40817', serial: 10_000_000 }), RangeError);
    assert.throws(() => buildAccountNumber('1234', { balanceAccount: '40817', serial: 1 }), RangeError);
  });

  it('счета разных клиентов отличаются, ключ меняется вместе с номером', () => {
    const numbers = new Set(
      Array.from({ length: 50 }, (_, serial) => buildAccountNumber(BIK, { balanceAccount: '40817', serial })),
    );
    assert.equal(numbers.size, 50);
    for (const number of numbers) assert.equal(isValidAccountNumber(BIK, number), true);
  });
});
