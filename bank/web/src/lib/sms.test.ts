import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractCode, smsViews } from './sms';
import type { SmsMessage } from './types';

const sms = (id: number, text: string): SmsMessage => ({ id, phone: '+79001110001', channel: 'SMS', kind: 'LOGIN_CODE', text, createdAt: '2026-10-20T12:00:00+03:00' });

describe('СМС с кодом входа', () => {
  it('код — ровно шесть цифр отдельным словом', () => {
    assert.equal(extractCode('Код входа в ЗапускБанк: 483920. Никому не сообщайте.'), '483920');
    assert.equal(extractCode('Перевод выполнен'), null);
    assert.equal(extractCode('Номер 12345 и 1234567'), null);
  });

  it('подставить можно только код самого нового сообщения, у старых — «заменён новым»', () => {
    const views = smsViews([sms(3, 'Код: 333333'), sms(2, 'Код: 222222'), sms(1, 'Код: 111111')]);
    assert.deepEqual(views.map((view) => [view.code, view.canFill, view.replaced]), [
      ['333333', true, false],
      ['222222', false, true],
      ['111111', false, true],
    ]);
  });

  it('сообщение без кода ничего не предлагает, даже если оно новее', () => {
    const views = smsViews([sms(2, 'Перевод выполнен'), sms(1, 'Код: 111111')]);
    assert.deepEqual(views.map((view) => [view.code, view.canFill, view.replaced]), [
      [null, false, false],
      ['111111', false, true],
    ]);
  });

  it('пустой список — пустой результат', () => {
    assert.deepEqual(smsViews([]), []);
  });
});
