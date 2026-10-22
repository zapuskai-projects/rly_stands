import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCardNumber, isValidLuhn, luhnCheckDigit, maskCardNumber } from './card';

describe('карты по Луну', () => {
  it('известные номера проходят проверку', () => {
    assert.equal(isValidLuhn('79927398713'), true);
    assert.equal(isValidLuhn('4111111111111111'), true);
    assert.equal(isValidLuhn('5555555555554444'), true);
  });

  it('известные неверные номера не проходят', () => {
    assert.equal(isValidLuhn('79927398710'), false);
    assert.equal(isValidLuhn('4111111111111112'), false);
    assert.equal(isValidLuhn('1'), false);
    assert.equal(isValidLuhn('4111 1111 1111 1111'), false);
  });

  it('контрольная цифра считается по номеру без неё', () => {
    assert.equal(luhnCheckDigit('7992739871'), 3);
    assert.equal(luhnCheckDigit('411111111111111'), 1);
  });

  it('собранная карта состоит из 16 цифр и проходит проверку', () => {
    for (const serial of [0, 1, 123456, 999999999]) {
      const number = buildCardNumber('990001', serial);
      assert.match(number, /^[0-9]{16}$/);
      assert.equal(isValidLuhn(number), true);
      assert.ok(number.startsWith('990001'));
    }
  });

  it('смена одной цифры ломает проверку', () => {
    const number = buildCardNumber('990001', 777);
    for (let position = 0; position < 16; position += 1) {
      const digit = Number(number[position]);
      const broken = `${number.slice(0, position)}${(digit + 1) % 10}${number.slice(position + 1)}`;
      assert.equal(isValidLuhn(broken), false, `позиция ${position}`);
    }
  });

  it('маска оставляет шесть первых и четыре последние цифры', () => {
    assert.equal(maskCardNumber('9900010000001234'), '990001******1234');
    assert.throws(() => maskCardNumber('1234'), RangeError);
  });

  it('некорректные входы отвергаются', () => {
    assert.throws(() => buildCardNumber('99', 1), RangeError);
    assert.throws(() => buildCardNumber('990001', -1), RangeError);
    assert.throws(() => luhnCheckDigit('12a'), RangeError);
  });
});
