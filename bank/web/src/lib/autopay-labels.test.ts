import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attemptNote, dateLabel, failureLabel, schedulePhrase, templateRecipient } from './autopay-labels';

describe('подписи шаблонов и автоплатежей', () => {
  it('дата словами с годом', () => {
    assert.equal(dateLabel('2026-11-21'), '21 ноября 2026');
    assert.equal(dateLabel('2027-01-05'), '5 января 2027');
  });

  it('получатель шаблона: телефон, телефон с банком, свои счета', () => {
    assert.equal(templateRecipient({ kind: 'PHONE', recipientPhone: '+79001110002', recipientBankName: 'ЗапускБанк', toAccount: null }), '+7 900 111-00-02');
    assert.equal(templateRecipient({ kind: 'SBP', recipientPhone: '+79000000021', recipientBankName: 'Банк «Северный ветер»', toAccount: null }), '+7 900 000-00-21 · Банк «Северный ветер»');
    assert.equal(templateRecipient({ kind: 'OWN', recipientPhone: null, recipientBankName: null, toAccount: '40817810100000001001' }), 'Между своими счетами');
  });

  it('расписание и причины понятны клиенту, неизвестная причина не ломает текст', () => {
    assert.equal(schedulePhrase({ dayOfMonth: 15 }), 'Каждого 15-го числа в 10:00');
    assert.equal(failureLabel('INSUFFICIENT_FUNDS'), 'недостаточно средств на счёте');
    assert.equal(failureLabel('SOMETHING'), 'банк не смог выполнить перевод');
    assert.equal(failureLabel(null), 'банк не смог выполнить перевод');
  });

  it('заметка о попытках: повтор ждёт, остановленный автоплатёж называет три попытки', () => {
    assert.equal(attemptNote({ status: 'ACTIVE', attempt: 0, failureReason: null }), null);
    assert.equal(attemptNote({ status: 'ACTIVE', attempt: 1, failureReason: 'INSUFFICIENT_FUNDS' }), 'Попытка 1 из 3 не удалась: недостаточно средств на счёте');
    assert.equal(attemptNote({ status: 'FAILED', attempt: 3, failureReason: 'INSUFFICIENT_FUNDS' }), 'Не удалось выполнить после 3 из 3 попыток: недостаточно средств на счёте');
  });
});
