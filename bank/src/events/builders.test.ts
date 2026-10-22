import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { configureTopics } from './topics';
import { amountInRubles, notificationOutboxMessage, paymentCreatedMessage, statusChangedMessage } from './builders';

const createdAt = new Date('2026-10-20T20:40:00.123Z');

describe('сообщения для брокеров', () => {
  afterEach(() => {
    configureTopics('');
  });

  it('событие создания: топик, ключ — номер клиента, заголовки, сумма в копейках', () => {
    const message = paymentCreatedMessage({
      operationId: 'op-1',
      operationNumber: 'ZB0000100001',
      clientNumber: '10000001',
      type: 'PHONE_TRANSFER',
      route: 'SBP',
      amount: 150000n,
      fee: 3000n,
      fromAccount: '40817810800000001000',
      recipientPhone: '+79001110002',
      recipientBankCode: 'KEDR',
      createdAt,
      requestId: 'req-12345678',
    });
    assert.equal(message.destination, 'KAFKA');
    assert.equal(message.topic, 'bank.payments.created');
    assert.equal(message.key, '10000001');
    assert.deepEqual(message.headers, { operationId: 'op-1', requestId: 'req-12345678' });
    const payload = message.payload as Record<string, unknown>;
    assert.equal(payload.amount, 150000);
    assert.equal(payload.fee, 3000);
    assert.equal(payload.createdAt, '2026-10-20T23:40:00.123+03:00');
    assert.match(String(payload.eventId), /^[0-9a-f-]{36}$/);
  });

  it('событие смены статуса несёт прежний и новый статус', () => {
    const message = statusChangedMessage({
      operationId: 'op-1',
      operationNumber: 'ZB0000100001',
      clientNumber: '10000001',
      previousStatus: 'CHECKING',
      status: 'ON_REVIEW',
      reasonCode: 'ANTIFRAUD_REVIEW',
      changedAt: createdAt,
      requestId: 'req-12345678',
    });
    assert.equal(message.topic, 'bank.payments.status-changed');
    assert.equal(message.key, '10000001');
    const payload = message.payload as Record<string, unknown>;
    assert.deepEqual([payload.previousStatus, payload.status, payload.reasonCode], ['CHECKING', 'ON_REVIEW', 'ANTIFRAUD_REVIEW']);
  });

  it('уведомление уходит в RabbitMQ с маршрутом и заголовками', () => {
    const message = notificationOutboxMessage({
      operationId: 'op-1',
      requestId: 'req-12345678',
      clientId: 'client-1',
      phone: '+79001110001',
      channel: 'SMS',
      kind: 'TRANSFER_COMPLETED',
      text: 'Перевод выполнен',
      createdAt,
    });
    assert.equal(message.destination, 'RABBIT');
    assert.equal(message.topic, 'bank.notifications');
    assert.equal(message.key, 'notification');
    assert.equal(message.headers.operationId, 'op-1');
  });

  it('префикс меняет имена топиков', () => {
    configureTopics('t1.');
    const message = statusChangedMessage({
      operationId: 'op-1',
      operationNumber: 'n',
      clientNumber: 'c',
      previousStatus: 'A',
      status: 'B',
      reasonCode: null,
      changedAt: createdAt,
      requestId: 'r',
    });
    assert.equal(message.topic, 't1.bank.payments.status-changed');
  });

  it('событие создания по умолчанию несёт копейки, с рублями сумма делится на сто, комиссия остаётся в копейках', () => {
    const input = {
      operationId: 'op-1',
      operationNumber: 'ZB0000100001',
      clientNumber: '10000001',
      type: 'PHONE_TRANSFER' as const,
      route: 'SBP' as const,
      amount: 150050n,
      fee: 3000n,
      fromAccount: '40817810800000001000',
      recipientPhone: '+79001110002',
      recipientBankCode: 'KEDR',
      createdAt,
      requestId: 'req-12345678',
    };
    assert.equal((paymentCreatedMessage(input).payload as { amount: number }).amount, 150050);
    assert.equal((paymentCreatedMessage({ ...input, amountInRubles: false }).payload as { amount: number }).amount, 150050);
    const inRubles = paymentCreatedMessage({ ...input, amountInRubles: true }).payload as { amount: number; fee: number };
    assert.equal(inRubles.amount, 1500.5);
    assert.equal(inRubles.fee, 3000);
    assert.equal(amountInRubles(100n), 1);
  });
});
