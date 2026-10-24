import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dayAndMonth, executedTexts, failedTexts, reasonText, reminderTexts } from './autopay-texts';

const facts = { name: 'Аренда', amount: 2_500_000n };

describe('тексты уведомлений автоплатежа', () => {
  it('напоминание называет дату, название и сумму', () => {
    const texts = reminderTexts(facts, '2026-11-15');
    assert.equal(texts.sms, 'ЗапускБанк: завтра, 15 ноября, спишется автоплатёж «Аренда»: 25 000,00 ₽. Проверьте остаток на счёте.');
    assert.equal(texts.push, 'Завтра автоплатёж «Аренда»: 25 000,00 ₽');
  });

  it('исполнение называет операцию', () => {
    const texts = executedTexts(facts, 'ZB0000100003');
    assert.match(texts.sms, /автоплатёж «Аренда» выполнен: 25 000,00 ₽\. Операция ZB0000100003\./);
    assert.match(texts.push, /^Автоплатёж «Аренда» выполнен/);
  });

  it('неисполнение с повтором называет дату и номер попытки, без повтора — что автоплатёж остановлен', () => {
    const retry = failedTexts(facts, 'INSUFFICIENT_FUNDS', 1, '2026-10-16');
    assert.match(retry.sms, /недостаточно средств на счёте\. Повторим 16 октября в 10:00, попытка 2 из 3\./);
    const final = failedTexts(facts, 'INSUFFICIENT_FUNDS', 3, null);
    assert.match(final.sms, /Автоплатёж остановлен: возобновить его можно в интернет-банке\./);
    assert.equal(final.push, 'Автоплатёж «Аренда» не выполнен: недостаточно средств на счёте. Автоплатёж остановлен');
  });

  it('отменённый автоплатёж не предлагает возобновление, автоплатёж на паузе — предлагает', () => {
    const ended = failedTexts(facts, 'AUTOPAYMENT_CANCELLED', 1, null, 'ENDED');
    assert.match(ended.sms, /автоплатёж отменён\. Автоплатёж завершён, повторов не будет\./);
    assert.equal(/возобнов/i.test(ended.sms + ended.push), false);
    const paused = failedTexts(facts, 'AUTOPAYMENT_PAUSED', 1, null, 'PAUSED');
    assert.match(paused.sms, /Автоплатёж на паузе: возобновить его можно в интернет-банке\./);
  });

  it('неизвестная причина не ломает текст', () => {
    assert.equal(reasonText('SOMETHING'), 'банк не смог выполнить перевод');
    assert.equal(reasonText(null), 'банк не смог выполнить перевод');
    assert.equal(dayAndMonth('2026-01-05'), '5 января');
  });
});
