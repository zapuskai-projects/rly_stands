import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Kafka, logLevel } from 'kafkajs';
import { READINESS } from '../../modules/readiness';
import { eventually, liveSuite } from './support';

type Facts = Record<string, any>;

const kafka = () =>
  new Kafka({ clientId: 'live-test', brokers: ['redpanda:9092'], logLevel: logLevel.NOTHING, retry: { retries: 2 } });

const MESSAGES_DEFINITIONS = {
  exchanges: [{ name: 'live.msg', vhost: '/', type: 'direct', durable: true, auto_delete: false, internal: false, arguments: {} }],
  queues: [{ name: 'live.msg.box', vhost: '/', durable: true, auto_delete: false, arguments: {} }],
  bindings: [{ source: 'live.msg', vhost: '/', destination: 'live.msg.box', destination_type: 'queue', routing_key: 'n', arguments: {} }],
};

liveSuite('messaging', READINESS.rabbitmq ?? [], 'RabbitMQ: сообщения очереди и уборка очередей', ({ probe }) => {
  it('сообщения читаются без удаления: JSON-объекты отдельно от слова и массива, очередь не пустеет', async () => {
    await probe('rabbitmq.importDefinitions', { definitions: MESSAGES_DEFINITIONS });
    for (const payload of ['{"kind":"TRANSFER_COMPLETED","amount":1500}', 'проверка', '[1,2]']) {
      assert.equal((await probe<Facts>('rabbitmq.publish', { exchange: 'live.msg', routingKey: 'n', payload })).routed, true);
    }
    const first = await eventually(
      () => probe<Facts>('rabbitmq.messages', { queue: 'live.msg.box' }),
      (value) => value.count >= 3,
      8000,
    );
    assert.equal(first.exists, true);
    assert.equal(first.count, 3);
    assert.equal(first.objectCount, 1);
    assert.equal(first.otherCount, 2);
    assert.deepEqual(first.objects, [{ kind: 'TRANSFER_COMPLETED', amount: 1500 }]);
    assert.deepEqual(first.bodies.slice(1), ['проверка', '[1,2]']);
    assert.equal(first.messages[0].routingKey, 'n');
    const second = await probe<Facts>('rabbitmq.messages', { queue: 'live.msg.box', limit: 2 });
    assert.equal(second.count, 2);
    const left = await eventually(
      () => probe<Facts>('rabbitmq.queue', { name: 'live.msg.box' }),
      (value) => value.messages === 3,
      8000,
    );
    assert.equal(left.messages, 3);
  });

  it('очереди нет — exists=false и нули', async () => {
    const facts = await probe<Facts>('rabbitmq.messages', { queue: 'live.msg.absent' });
    assert.deepEqual([facts.exists, facts.count, facts.objectCount], [false, 0, 0]);
  });

  it('очистка оставляет очередь пустой, удаление убирает её; несуществующие очереди не ошибка', async () => {
    assert.deepEqual(await probe('rabbitmq.purgeQueues', { names: ['live.msg.box', 'live.msg.absent'] }), { purged: ['live.msg.box'] });
    const purged = await eventually(
      () => probe<Facts>('rabbitmq.queue', { name: 'live.msg.box' }),
      (value) => value.messages === 0,
      8000,
    );
    assert.equal(purged.exists, true);
    assert.equal(purged.messages, 0);
    assert.deepEqual(await probe('rabbitmq.deleteQueues', { names: ['live.msg.box', 'live.msg.absent'] }), { deleted: ['live.msg.box'] });
    assert.equal((await probe<Facts>('rabbitmq.queue', { name: 'live.msg.box' })).exists, false);
    assert.deepEqual(await probe('rabbitmq.deleteQueues', { names: ['live.msg.box'] }), { deleted: [] });
  });
});

liveSuite('messaging', (READINESS.kafka ?? []).slice(0, 1), 'Kafka: группы потребителей студента', ({ probe }) => {
  const run = Date.now().toString(36);
  const topic = `live.groups.${run}`;

  const readAll = async (groupId: string, hold = false) => {
    const consumer = kafka().consumer({ groupId });
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    let seen = 0;
    await consumer.run({ eachMessage: async () => void (seen += 1) });
    await eventually(async () => seen, (value) => value >= 2, 15_000, 300);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (!hold) {
      await consumer.stop();
      await consumer.disconnect();
    }
    return consumer;
  };

  it('группа с сохранёнными смещениями видна, группа банка и служебные пульта не считаются', async () => {
    await probe('kafka.createTopic', { name: topic, partitions: 1 });
    await probe('kafka.produce', { topic, messages: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] });
    assert.equal((await probe<Facts>('kafka.consumerGroups', { topic })).count, 0);
    await readAll(`student-${run}`);
    await readAll('bank-antifraud');
    await probe('kafka.messages', { topic });
    const facts = await eventually(
      () => probe<Facts>('kafka.consumerGroups', { topic }),
      (value) => value.count >= 1,
      10_000,
    );
    assert.deepEqual(facts.groupIds, [`student-${run}`]);
    assert.equal(facts.groups[0].committedTotal, 2);
    assert.equal(facts.groups[0].members, 0);
    assert.equal((await probe<Facts>('kafka.consumerGroups', { topic, exclude: [`student-${run}`] })).count, 0);
  });

  it('удаление убирает пустые группы студента, группу с участником пропускает, группа банка остаётся', async () => {
    const busy = await readAll(`busy-${run}`, true);
    const result = await probe<Facts>('kafka.deleteConsumerGroups', { topic });
    assert.deepEqual(result.deleted, [`student-${run}`]);
    assert.deepEqual(result.skipped, [`busy-${run}`]);
    await busy.stop();
    await busy.disconnect();
    const left = await eventually(
      () => probe<Facts>('kafka.consumerGroups', { topic }),
      (value) => value.groupIds.length === 1,
      10_000,
    );
    assert.deepEqual(left.groupIds, [`busy-${run}`]);
    assert.equal((await probe<Facts>('kafka.consumerGroup', { groupId: 'bank-antifraud' })).exists, true);
    await eventually(
      () => probe<Facts>('kafka.deleteConsumerGroups', { topic }),
      (value) => value.deleted.length === 1,
      10_000,
    );
    assert.equal((await probe<Facts>('kafka.consumerGroups', { topic })).count, 0);
  });

  it('readAsGroup читает топик группой и сохраняет смещения: группа видна проверке', async () => {
    const groupId = `reader-${run}`;
    await probe('kafka.deleteConsumerGroups', { topic });
    const result = await probe<Facts>('kafka.readAsGroup', { topic, groupId });
    assert.equal(result.read, 2);
    const facts = await eventually(
      () => probe<Facts>('kafka.consumerGroups', { topic }),
      (value) => value.groupIds.includes(groupId),
      10_000,
    );
    assert.equal(facts.groups.find((group: Facts) => group.groupId === groupId).committedTotal, 2);
    await probe('kafka.deleteConsumerGroups', { topic });
  });
});
