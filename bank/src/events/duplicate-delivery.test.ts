import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { duplicateDeliveryMark, isRepeatedOperation, shouldDeliverTwice } from './duplicate-delivery';
import type { OutboxRecord } from './outbox.repository';

function record(topic: string, operationNumber: string, destination: OutboxRecord['destination'] = 'KAFKA'): OutboxRecord {
  return { id: 1, attempts: 0, destination, topic, key: 'client', headers: {}, payload: { eventId: 'e-1', operationId: 'op', operationNumber }, createdAt: new Date() };
}

describe('повторная доставка событий', () => {
  it('повторяются операции с нечётным последним знаком номера', () => {
    assert.equal(isRepeatedOperation('ZB0000100001'), true);
    assert.equal(isRepeatedOperation('ZB0000100002'), false);
    assert.equal(isRepeatedOperation('ZB0000100003'), true);
    assert.equal(isRepeatedOperation('без цифр'), false);
  });

  it('из трёх подряд идущих операций повтор есть всегда', () => {
    for (let first = 100_001; first < 100_011; first += 1) {
      const flags = [first, first + 1, first + 2].map((number) => isRepeatedOperation(`ZB${number}`));
      assert.ok(flags.includes(true) && flags.includes(false), String(first));
    }
  });

  it('повторяются события создания и смены статуса в Kafka, но не уведомления и не решения антифрода', () => {
    assert.equal(shouldDeliverTwice(record('bank.payments.created', 'ZB0000100001')), true);
    assert.equal(shouldDeliverTwice(record('bank.payments.status-changed', 'ZB0000100001')), true);
    assert.equal(shouldDeliverTwice(record('bank.antifraud.decisions', 'ZB0000100001')), false);
    assert.equal(shouldDeliverTwice(record('bank.notifications', 'ZB0000100001', 'RABBIT')), false);
    assert.equal(shouldDeliverTwice(record('bank.payments.created', 'ZB0000100002')), false);
  });

  it('пометка называет топик и событие', () => {
    assert.deepEqual(duplicateDeliveryMark(record('bank.payments.created', 'ZB0000100001')), {
      code: 'events.duplicate-delivery',
      details: { topic: 'bank.payments.created', eventId: 'e-1', deliveries: 2 },
    });
  });
});
