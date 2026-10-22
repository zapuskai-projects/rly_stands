import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recipientTexts, senderTexts, type CompletedTransferFacts } from './texts';

const phoneTransfer: CompletedTransferFacts = {
  type: 'PHONE_TRANSFER',
  amount: 150000n,
  operationNumber: 'ZB0000100001',
  recipientName: 'Пётр И.',
  recipientPhone: '+79001110002',
  recipientBankName: 'ЗапускБанк',
  senderShortName: 'Анна С.',
};

describe('тексты уведомлений о проведении', () => {
  it('отправитель получает СМС и пуш с суммой, получателем и номером операции', () => {
    const texts = senderTexts(phoneTransfer);
    assert.equal(texts.sms, 'ЗапускБанк: перевод 1 500,00 ₽ получателю Пётр И. выполнен. Операция ZB0000100001.');
    assert.equal(texts.push, 'Перевод выполнен: 1 500,00 ₽ получателю Пётр И.');
  });

  it('перевод в другой банк называет банк и скрывает середину номера', () => {
    const texts = senderTexts({ ...phoneTransfer, recipientName: null, recipientBankName: 'Банк «Кедр»' });
    assert.match(texts.sms, /на номер \+7 900 \*\*\*-\*\*-02 \(Банк «Кедр»\)/);
  });

  it('перевод между своими счетами не называет получателя', () => {
    const texts = senderTexts({ ...phoneTransfer, type: 'OWN_TRANSFER', recipientName: null, recipientPhone: null });
    assert.match(texts.sms, /между вашими счетами выполнен/);
  });

  it('получатель видит, от кого пришли деньги', () => {
    const texts = recipientTexts(phoneTransfer);
    assert.equal(texts.sms, 'ЗапускБанк: вам поступил перевод 1\u00a0500,00\u00a0₽. Отправитель: Анна С. Операция ZB0000100001.');
    assert.equal(texts.push, 'Вам поступил перевод 1\u00a0500,00\u00a0₽. Отправитель: Анна С.');
  });
});
