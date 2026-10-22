import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dayLabel,
  greeting,
  formatAccountNumber,
  formatMoney,
  formatPhone,
  formatSignedMoney,
  formatWholeRubles,
  initials,
  normalizePhone,
  bpsToPercentText,
  kopecksToInput,
  parseAmount,
  parseAmountOrZero,
  parsePercent,
  remainingLabel,
  timeOf,
} from './format';

describe('деньги на экране', () => {
  it('копейки превращаются в рубли с разрядами и запятой', () => {
    assert.equal(formatMoney(0), '0,00 ₽');
    assert.equal(formatMoney(5), '0,05 ₽');
    assert.equal(formatMoney(150000), '1 500,00 ₽');
    assert.equal(formatMoney(12345678), '123 456,78 ₽');
    assert.equal(formatMoney(-250), '−2,50 ₽');
  });

  it('целые рубли без копеек и знак операции', () => {
    assert.equal(formatWholeRubles(15000000), '150 000 ₽');
    assert.equal(formatSignedMoney(150000, 'out'), '−1 500,00 ₽');
    assert.equal(formatSignedMoney(150000, 'in'), '+1 500,00 ₽');
  });

  it('сумма из поля ввода разбирается без дробных чисел', () => {
    assert.equal(parseAmount('15 000'), 1500000);
    assert.equal(parseAmount('15 000 ₽'), 1500000);
    assert.equal(parseAmount('1500,5'), 150050);
    assert.equal(parseAmount('0,01'), 1);
    assert.equal(parseAmount('19.99'), 1999);
  });

  it('неверная сумма не разбирается', () => {
    for (const input of ['', '0', '0,00', '-5', '1,234', 'abc', '10 000 000 000 000', '1,5,5']) assert.equal(parseAmount(input), null, input);
  });
});

describe('поля тарифа', () => {
  it('ноль в суммах тарифа допустим, пустое поле — нет', () => {
    assert.equal(parseAmountOrZero('0'), 0);
    assert.equal(parseAmountOrZero('0,00'), 0);
    assert.equal(parseAmountOrZero('30'), 3000);
    assert.equal(parseAmountOrZero(''), null);
    assert.equal(parseAmountOrZero('abc'), null);
  });

  it('проценты разбираются в сотые доли процента', () => {
    assert.equal(parsePercent('1'), 100);
    assert.equal(parsePercent('0,5'), 50);
    assert.equal(parsePercent('2.25 %'), 225);
    assert.equal(parsePercent('100'), 10000);
    assert.equal(parsePercent('100,01'), null);
    assert.equal(parsePercent('1,234'), null);
    assert.equal(parsePercent(''), null);
  });

  it('значения возвращаются в поля ввода', () => {
    assert.equal(kopecksToInput(15000000), '150000');
    assert.equal(kopecksToInput(3050), '30,50');
    assert.equal(bpsToPercentText(100), '1');
    assert.equal(bpsToPercentText(50), '0,5');
    assert.equal(bpsToPercentText(225), '2,25');
  });
});

describe('телефон', () => {
  it('вывод по группам цифр', () => {
    assert.equal(formatPhone('+79001110002'), '+7 900 111-00-02');
    assert.equal(formatPhone('abc'), 'abc');
  });

  it('ввод в любом привычном виде приводится к +79XXXXXXXXX', () => {
    for (const input of ['+7 900 111-00-02', '8 (900) 111-00-02', '79001110002', '900 111 00 02', '+79001110002']) {
      assert.equal(normalizePhone(input), '+79001110002', input);
    }
  });

  it('городские, короткие и чужие номера отвергаются', () => {
    for (const input of ['', '+7 495 111-00-02', '900111000', '+1 900 111 00 02', '8 800 555 35 35']) assert.equal(normalizePhone(input), null, input);
  });
});

describe('даты банка', () => {
  it('время берётся из строки с московским смещением', () => {
    assert.equal(timeOf('2026-10-20T23:40:12.000+03:00'), '23:40');
  });

  it('подписи дня: сегодня, вчера, дата', () => {
    assert.equal(dayLabel('2026-10-20', '2026-10-20'), 'Сегодня');
    assert.equal(dayLabel('2026-10-19', '2026-10-20'), 'Вчера');
    assert.equal(dayLabel('2026-10-02', '2026-10-20'), '02.10.2026');
    assert.equal(dayLabel('2026-09-30', '2026-10-01'), 'Вчера');
  });

  it('оставшееся время до срока в минутах и секундах', () => {
    assert.equal(remainingLabel('2026-10-21T00:10:00.000+03:00', '2026-10-20T23:40:00.000+03:00'), '30:00');
    assert.equal(remainingLabel('2026-10-21T00:10:00.000+03:00', '2026-10-21T00:09:15.000+03:00'), '00:45');
    assert.equal(remainingLabel('2026-10-21T00:10:00.000+03:00', '2026-10-21T00:11:00.000+03:00'), '00:00');
  });
});

describe('приветствие', () => {
  it('по часу банка', () => {
    assert.equal(greeting(4), 'Доброй ночи');
    assert.equal(greeting(5), 'Доброе утро');
    assert.equal(greeting(12), 'Добрый день');
    assert.equal(greeting(18), 'Добрый вечер');
    assert.equal(greeting(23), 'Добрый вечер');
    assert.equal(greeting(0), 'Доброй ночи');
  });
});

describe('реквизиты', () => {
  it('номер счёта группируется как в банковских документах', () => {
    assert.equal(formatAccountNumber('40817810800000001000'), '40817 810 8 0000 0001000');
    assert.equal(formatAccountNumber('123'), '123');
  });
});

describe('аватар', () => {
  it('две первые буквы имени, ИП пропускается', () => {
    assert.equal(initials('Анна Соколова'), 'АС');
    assert.equal(initials('ИП Гарипов Р. Ф.'), 'ГР');
    assert.equal(initials('Мария П.'), 'МП');
    assert.equal(initials(''), '');
  });
});
