import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { channelLabel, notificationKindLabels, recipientLabel, reviewSummary } from './office-labels';

describe('подписи офиса', () => {
  it('получатель: имя, банк для чужих банков, телефон без имени', () => {
    assert.equal(recipientLabel({ type: 'PHONE_TRANSFER', recipient: { phone: '+79001110002', bankCode: 'ZAPUSK', bankName: 'ЗапускБанк', displayName: 'Пётр И.' } }), 'Пётр И.');
    assert.equal(recipientLabel({ type: 'PHONE_TRANSFER', recipient: { phone: '+79000000017', bankCode: 'NORTHWIND', bankName: 'Банк «Северный ветер»', displayName: 'Мария П.' } }), 'Мария П., Банк «Северный ветер»');
    assert.equal(recipientLabel({ type: 'PHONE_TRANSFER', recipient: { phone: '+79005550000', bankCode: 'KEDR', bankName: 'Банк «Кедр»', displayName: null } }), '+7 900 555-00-00, Банк «Кедр»');
    assert.equal(recipientLabel({ type: 'OWN_TRANSFER', recipient: { phone: null, bankCode: null, bankName: null, displayName: null } }), 'Свои счета клиента');
    assert.equal(recipientLabel({ type: 'QR_PAYMENT', recipient: { phone: null, bankCode: null, bankName: null, displayName: 'Лавка Гарипова' } }), 'Лавка Гарипова');
  });

  it('строка очереди называет оценку и сработавшие правила коротко', () => {
    assert.equal(reviewSummary(72, ['NEW_RECIPIENT', 'NIGHT_TIME', 'AMOUNT_ABOVE_USUAL']), 'Оценка 72 · новый получатель, ночь, сумма выше обычной');
    assert.equal(reviewSummary(0, []), 'Оценка 0');
    assert.equal(reviewSummary(20, ['UNKNOWN']), 'Оценка 20 · UNKNOWN');
  });

  it('канал перевода', () => {
    assert.equal(channelLabel({ type: 'PHONE_TRANSFER', route: 'SBP' }), 'по номеру телефона через СБП');
    assert.equal(channelLabel({ type: 'PHONE_TRANSFER', route: 'INTERNAL' }), 'по номеру телефона');
    assert.equal(channelLabel({ type: 'OWN_TRANSFER', route: 'INTERNAL' }), 'между своими счетами');
    assert.equal(channelLabel({ type: 'QR_PAYMENT', route: 'INTERNAL' }), 'оплата по QR');
  });

  it('виды уведомлений об автоплатежах появляются только с релиза 1.1', () => {
    assert.equal('AUTOPAYMENT_FAILED' in notificationKindLabels(false), false);
    assert.equal(Object.keys(notificationKindLabels(false)).length, 3);
    assert.equal(notificationKindLabels(true).AUTOPAYMENT_FAILED, 'Автоплатёж не выполнен');
    assert.equal(notificationKindLabels(true).TRANSFER_COMPLETED, 'Перевод выполнен');
  });
});
