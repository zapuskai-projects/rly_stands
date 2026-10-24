import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertDeletableQueues, assertPurgeableQueues, describeQueueMessage, queueMessageFacts, readOrderFacts } from './rabbitmq';

describe('rabbitmq.readOrder: порядок чтения очереди', () => {
  const sent = [
    { id: 'normal', marker: 'm-1' },
    { id: 'urgent', marker: 'm-2' },
  ];

  it('порядок берётся из ответа очереди, а не из порядка публикации', () => {
    assert.deepEqual(readOrderFacts(sent, ['m-2', 'm-1']), { readOrder: ['urgent', 'normal'], missing: [] });
    assert.deepEqual(readOrderFacts(sent, ['m-1', 'm-2']), { readOrder: ['normal', 'urgent'], missing: [] });
  });

  it('чужие сообщения очереди пропускаются, не вернувшиеся попадают в missing', () => {
    assert.deepEqual(readOrderFacts(sent, ['чужое', 'm-2', 'ещё-чужое']), { readOrder: ['urgent'], missing: ['normal'] });
    assert.deepEqual(readOrderFacts(sent, []), { readOrder: [], missing: ['normal', 'urgent'] });
  });
});

describe('rabbitmq.messages: сообщения очереди', () => {
  const notification = {
    payload: '{"operationId":"op-1","kind":"TRANSFER_COMPLETED","amount":1500}',
    payload_encoding: 'string',
    routing_key: 'notification',
    redelivered: false,
    properties: { headers: { requestId: 'r-1' } },
  };
  const word = { payload: 'проверка', payload_encoding: 'string', routing_key: 'notification', redelivered: true, properties: {} };
  const array = { payload: '[1,2]', payload_encoding: 'string', routing_key: 'notification', properties: {} };

  it('тело разобрано как JSON, заголовки и ключ маршрутизации сохранены', () => {
    const message = describeQueueMessage(notification);
    assert.deepEqual(message.json, { operationId: 'op-1', kind: 'TRANSFER_COMPLETED', amount: 1500 });
    assert.equal(message.isObject, true);
    assert.equal(message.routingKey, 'notification');
    assert.deepEqual(message.headers, { requestId: 'r-1' });
  });

  it('слово и массив — не объекты-уведомления и в objects не попадают', () => {
    const facts = queueMessageFacts([notification, word, array].map(describeQueueMessage));
    assert.equal(facts.count, 3);
    assert.equal(facts.objectCount, 1);
    assert.equal(facts.otherCount, 2);
    assert.deepEqual(facts.objects, [{ operationId: 'op-1', kind: 'TRANSFER_COMPLETED', amount: 1500 }]);
    assert.deepEqual(facts.bodies.slice(1), ['проверка', '[1,2]']);
  });

  it('двоичное тело в base64 читается как текст', () => {
    const encoded = { ...word, payload: Buffer.from('проверка').toString('base64'), payload_encoding: 'base64' };
    assert.equal(describeQueueMessage(encoded).body, 'проверка');
  });

  it('пустая очередь — нули', () => {
    const facts = queueMessageFacts([]);
    assert.deepEqual([facts.count, facts.objectCount, facts.otherCount], [0, 0, 0]);
  });
});

describe('rabbitmq: очереди банка защищены', () => {
  it('удаление отказывает для любых имён bank.*, свои очереди студента удаляются', () => {
    assert.throws(() => assertDeletableQueues(['mobile-notifications', 'bank.notifications']), /Очереди банка удалять нельзя: bank\.notifications/);
    assert.throws(() => assertDeletableQueues(['bank.notifications.dlq']), /удалять нельзя/);
    assert.doesNotThrow(() => assertDeletableQueues(['mobile-notifications']));
  });

  it('очистка bank.* разрешена только для явного списка', () => {
    assert.doesNotThrow(() => assertPurgeableQueues(['bank.notifications.dlq', 'mobile-notifications']));
    assert.throws(() => assertPurgeableQueues(['bank.notifications']), /Очереди банка очищать нельзя: bank\.notifications/);
    assert.throws(() => assertPurgeableQueues(['bank.payments', 'bank.notifications.dlq']), /bank\.payments/);
  });
});
