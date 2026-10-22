import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskPhone, shortName } from './names';

describe('телефон и имя получателя', () => {
  it('телефон скрывает середину', () => {
    assert.equal(maskPhone('+79001110002'), '+7 900 ***-**-02');
  });

  it('телефон неверного формата отвергается', () => {
    assert.throws(() => maskPhone('89001110002'), RangeError);
    assert.throws(() => maskPhone('+74951110002'), RangeError);
  });

  it('имя сокращается до имени и инициала фамилии', () => {
    assert.equal(shortName('Пётр Ильин'), 'Пётр И.');
    assert.equal(shortName('Ли Вэй'), 'Ли В.');
  });

  it('предприниматель показывается как есть', () => {
    assert.equal(shortName('ИП Гарипов Р. Ф.'), 'ИП Гарипов Р. Ф.');
  });

  it('одно слово остаётся без изменений', () => {
    assert.equal(shortName('Анна'), 'Анна');
  });
});
