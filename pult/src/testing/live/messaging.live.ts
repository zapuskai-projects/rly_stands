import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Kafka, logLevel } from 'kafkajs';
import { READINESS } from '../../modules/readiness';
import { eventually, liveSuite } from './support';

type Facts = Record<string, any>;

const DEFINITIONS = {
  exchanges: [{ name: 'live.orders', vhost: '/', type: 'topic', durable: true, auto_delete: false, internal: false, arguments: {} }],
  queues: [
    { name: 'live.orders.new', vhost: '/', durable: true, auto_delete: false, arguments: {} },
    { name: 'live.orders.audit', vhost: '/', durable: true, auto_delete: false, arguments: {} },
  ],
  bindings: [
    { source: 'live.orders', vhost: '/', destination: 'live.orders.new', destination_type: 'queue', routing_key: 'order.new', arguments: {} },
  ],
};

liveSuite('messaging', READINESS.rabbitmq ?? [], 'RabbitMQ: проверки на живом брокере', ({ probe }) => {
  it('определения загружаются, обменник, очередь и привязка читаются', async () => {
    assert.deepEqual(await probe('rabbitmq.importDefinitions', { definitions: DEFINITIONS }), { imported: true });
    const exchange = await probe<Facts>('rabbitmq.exchange', { name: 'live.orders' });
    assert.equal(exchange.exists, true);
    assert.equal(exchange.type, 'topic');
    assert.equal(exchange.durable, true);
    const queue = await probe<Facts>('rabbitmq.queue', { name: 'live.orders.new' });
    assert.equal(queue.exists, true);
    assert.equal(queue.durable, true);
    const bindings = await probe<Facts>('rabbitmq.bindings', { source: 'live.orders' });
    assert.equal(bindings.count, 1);
    assert.deepEqual(
      { destination: bindings.bindings[0].destination, routingKey: bindings.bindings[0].routingKey, type: bindings.bindings[0].destinationType },
      { destination: 'live.orders.new', routingKey: 'order.new', type: 'queue' },
    );
  });

  it('чего нет в брокере — факты exists=false, а не сбой', async () => {
    assert.equal((await probe<Facts>('rabbitmq.exchange', { name: 'live.missing' })).exists, false);
    assert.equal((await probe<Facts>('rabbitmq.queue', { name: 'live.missing' })).exists, false);
    assert.equal((await probe<Facts>('rabbitmq.bindings', { source: 'live.missing' })).count, 0);
  });

  it('маршрутизация: сообщение доходит только до очереди с подходящим ключом привязки', async () => {
    const routed = await probe<Facts>('rabbitmq.route', {
      exchange: 'live.orders',
      routingKey: 'order.new',
      payload: '{"id":1}',
      watchQueues: ['live.orders.new', 'live.orders.audit'],
    });
    assert.equal(routed.published, true);
    assert.equal(routed.routed, true);
    assert.deepEqual(routed.deliveredTo, ['live.orders.new']);
    assert.deepEqual(routed.notDeliveredTo, ['live.orders.audit']);
    assert.deepEqual(routed.queues, { 'live.orders.new': 1, 'live.orders.audit': 0 });
  });

  it('ключ без привязки не маршрутизируется, обменника нет — публикации нет', async () => {
    const unrouted = await probe<Facts>('rabbitmq.route', {
      exchange: 'live.orders',
      routingKey: 'order.other',
      payload: 'x',
      watchQueues: ['live.orders.new'],
    });
    assert.equal(unrouted.published, true);
    assert.equal(unrouted.routed, false);
    assert.deepEqual(unrouted.deliveredTo, []);
    const missing = await probe<Facts>('rabbitmq.route', {
      exchange: 'live.nowhere',
      routingKey: 'a',
      payload: 'x',
      watchQueues: ['live.orders.new'],
    });
    assert.equal(missing.published, false);
    assert.deepEqual(missing.notDeliveredTo, ['live.orders.new']);
  });

  it('публикация возвращает признак маршрутизации, сообщения копятся в очереди', async () => {
    const published = await probe<Facts>('rabbitmq.publish', { exchange: 'live.orders', routingKey: 'order.new', payload: 'p' });
    assert.equal(published.routed, true);
    const queue = await eventually(
      () => probe<Facts>('rabbitmq.queue', { name: 'live.orders.new' }),
      (value) => value.messages >= 2,
      8000,
    );
    assert.ok(queue.messages >= 2, `в очереди ${queue.messages}`);
  });
});

const PRIORITY_DEFINITIONS = {
  exchanges: [{ name: 'live.prio', vhost: '/', type: 'direct', durable: true, auto_delete: false, internal: false, arguments: {} }],
  queues: [
    { name: 'live.prio.ranked', vhost: '/', durable: true, auto_delete: false, arguments: { 'x-max-priority': 10 } },
    { name: 'live.prio.plain', vhost: '/', durable: true, auto_delete: false, arguments: {} },
  ],
  bindings: [
    { source: 'live.prio', vhost: '/', destination: 'live.prio.ranked', destination_type: 'queue', routing_key: 'ranked', arguments: {} },
    { source: 'live.prio', vhost: '/', destination: 'live.prio.plain', destination_type: 'queue', routing_key: 'plain', arguments: {} },
  ],
};

liveSuite('messaging', READINESS.rabbitmq ?? [], 'RabbitMQ: порядок чтения очереди с приоритетами', ({ probe }) => {
  const order = (queue: string) =>
    probe<Facts>('rabbitmq.readOrder', {
      exchange: 'live.prio',
      routingKey: queue,
      queue: `live.prio.${queue}`,
      messages: [
        { id: 'normal', priority: 1 },
        { id: 'urgent', priority: 9 },
      ],
    });

  it('очередь с приоритетами отдаёт срочное первым, обычная очередь — в порядке отправки', async () => {
    await probe('rabbitmq.importDefinitions', { definitions: PRIORITY_DEFINITIONS });
    const ranked = await order('ranked');
    assert.equal(ranked.published, true);
    assert.equal(ranked.routed, true);
    assert.deepEqual(ranked.readOrder, ['urgent', 'normal']);
    assert.deepEqual(ranked.missing, []);
    assert.deepEqual((await order('plain')).readOrder, ['normal', 'urgent']);
  });

  it('повторный прогон видит только свои сообщения, чтение их не забирает; нет обменника — публикации нет', async () => {
    const again = await order('ranked');
    assert.deepEqual(again.readOrder, ['urgent', 'normal']);
    const queue = await eventually(
      () => probe<Facts>('rabbitmq.queue', { name: 'live.prio.ranked' }),
      (value) => value.messages >= 4,
      8000,
    );
    assert.ok(queue.messages >= 4, `в очереди ${queue.messages}`);
    const missing = await probe<Facts>('rabbitmq.readOrder', {
      exchange: 'live.nowhere',
      routingKey: 'a',
      queue: 'live.prio.ranked',
      messages: [{ id: 'one' }, { id: 'two' }],
    });
    assert.equal(missing.published, false);
    assert.deepEqual(missing.readOrder, []);
    assert.deepEqual(missing.missing, ['one', 'two']);
  });
});

const kafka = () =>
  new Kafka({ clientId: 'live-test', brokers: ['redpanda:9092'], logLevel: logLevel.NOTHING, retry: { retries: 2 } });

liveSuite('messaging', (READINESS.kafka ?? []).slice(0, 1), 'Kafka: проверки на живом брокере', ({ probe }) => {
  const run = Date.now().toString(36);
  it('топик создаётся один раз, параметры читаются', async () => {
    assert.deepEqual(await probe('kafka.createTopic', { name: `live.orders.${run}`, partitions: 3, configs: { 'retention.ms': '3600000' } }), {
      created: true,
    });
    assert.deepEqual(await probe('kafka.createTopic', { name: `live.orders.${run}`, partitions: 5 }), { created: false });
    const topic = await probe<Facts>('kafka.topic', { name: `live.orders.${run}` });
    assert.equal(topic.exists, true);
    assert.equal(topic.partitions, 3);
    assert.equal(topic.replicationFactor, 1);
    assert.equal(topic.configs['retention.ms'], '3600000');
  });

  it('несуществующий топик — exists=false', async () => {
    const topic = await probe<Facts>('kafka.topic', { name: `live.missing.${run}` });
    assert.equal(topic.exists, false);
    assert.equal(topic.partitions, 0);
  });

  it('одинаковый ключ всегда в одной партиции и по порядку', async () => {
    const messages = ['a', 'b', 'a', 'b', 'a', 'c'].map((key, index) => ({ key, value: `${key}-${index}` }));
    const located = await probe<Facts>('kafka.produceAndLocate', { topic: `live.orders.${run}`, messages });
    assert.equal(located.results.length, 6);
    for (const key of ['a', 'b', 'c']) {
      assert.equal(located.keys[key].samePartition, true, `ключ ${key}`);
      assert.equal(located.keys[key].ordered, true, `ключ ${key}`);
    }
  });

  it('в несуществующий топик ничего не пишется и топик не создаётся', async () => {
    const located = await probe<Facts>('kafka.produceAndLocate', { topic: `live.never.${run}`, messages: [{ key: 'a', value: '1' }] });
    assert.deepEqual(located, { results: [], keys: {} });
    assert.equal((await probe<Facts>('kafka.topic', { name: `live.never.${run}` })).exists, false);
  });

  it('сообщения читаются с фильтром и заголовками, лимит режет выдачу', async () => {
    await probe('kafka.createTopic', { name: `live.read.${run}`, partitions: 1 });
    await probe('kafka.produce', {
      topic: `live.read.${run}`,
      messages: [
        { key: 'k1', value: 'первое', headers: { source: 'live' } },
        { key: 'k2', value: 'второе' },
        { key: 'k3', value: 'третье' },
      ],
    });
    const all = await probe<Facts>('kafka.messages', { topic: `live.read.${run}` });
    assert.equal(all.count, 3);
    assert.deepEqual(all.messages.map((item: Facts) => item.key), ['k1', 'k2', 'k3']);
    assert.equal(all.messages[0].headers.source, 'live');
    const filtered = await probe<Facts>('kafka.messages', { topic: `live.read.${run}`, match: 'второе' });
    assert.equal(filtered.count, 1);
    assert.equal(filtered.messages[0].key, 'k2');
    assert.equal((await probe<Facts>('kafka.messages', { topic: `live.read.${run}`, limit: 2 })).count, 2);
    assert.deepEqual(await probe('kafka.messages', { topic: `live.never.${run}` }), { count: 0, byKey: [], messages: [], fields: [] });
  });

  it('сводка по ключам: партиция одна на ключ, порядок по полю значения внутри партиции', async () => {
    await probe('kafka.createTopic', { name: `live.events.${run}`, partitions: 3 });
    const event = (documentId: string, at: string) => ({ key: documentId, value: JSON.stringify({ documentId, type: 'step', at }) });
    await probe('kafka.produce', {
      topic: `live.events.${run}`,
      messages: [
        event('doc-1', '2026-10-21T09:00:00Z'),
        event('doc-2', '2026-10-21T09:10:00Z'),
        event('doc-1', '2026-10-21T09:05:00Z'),
        event('doc-2', '2026-10-21T09:00:00Z'),
        event('doc-1', '2026-10-21T09:10:00Z'),
      ],
    });
    const facts = await probe<Facts>('kafka.messages', { topic: `live.events.${run}` });
    const byKey = Object.fromEntries(facts.byKey.map((item: Facts) => [item.key, item]));
    assert.equal(byKey['doc-1'].count, 3);
    assert.equal(byKey['doc-1'].partitions.length, 1);
    assert.deepEqual(byKey['doc-1'].orderedBy, { field: 'at', ok: true });
    assert.equal(byKey['doc-2'].count, 2);
    assert.equal(byKey['doc-2'].orderedBy.ok, false);
    const other = await probe<Facts>('kafka.messages', { topic: `live.events.${run}`, match: 'doc-1', orderField: 'type' });
    assert.deepEqual(other.byKey.map((item: Facts) => item.orderedBy), [{ field: 'type', ok: true }]);
  });

  it('группа потребителей: нет группы, живой потребитель без отставания, остановленный с отставанием', async () => {
    const absent = await probe<Facts>('kafka.consumerGroup', { groupId: `live-no-group.${run}` });
    assert.equal(absent.exists, false);
    assert.equal(absent.state, 'Dead');

    await probe('kafka.createTopic', { name: `live.lag.${run}`, partitions: 1 });
    await probe('kafka.produce', { topic: `live.lag.${run}`, messages: [{ key: 'a', value: '1' }, { key: 'a', value: '2' }] });
    const consumer = kafka().consumer({ groupId: `live-group.${run}` });
    let seen = 0;
    await consumer.connect();
    await consumer.subscribe({ topic: `live.lag.${run}`, fromBeginning: true });
    await consumer.run({
      autoCommit: true,
      autoCommitInterval: 500,
      eachMessage: async () => {
        seen += 1;
      },
    });
    await eventually(async () => seen, (value) => value >= 2, 15_000);
    assert.equal(seen, 2);
    const live = await eventually(
      () => probe<Facts>('kafka.consumerGroup', { groupId: `live-group.${run}` }),
      (value) => value.exists === true && value.members === 1 && value.lag === 0,
      15_000,
    );
    assert.equal(live.exists, true);
    assert.equal(live.state, 'Stable');
    assert.equal(live.members, 1);
    assert.equal(live.lag, 0);

    await consumer.stop();
    await consumer.disconnect();
    await probe('kafka.produce', { topic: `live.lag.${run}`, messages: [{ key: 'a', value: '3' }, { key: 'a', value: '4' }, { key: 'a', value: '5' }] });
    const stopped = await eventually(
      () => probe<Facts>('kafka.consumerGroup', { groupId: `live-group.${run}` }),
      (value) => value.members === 0 && value.lag === 3,
      15_000,
    );
    assert.equal(stopped.exists, true);
    assert.equal(stopped.members, 0);
    assert.equal(stopped.lag, 3);
    assert.equal(stopped.topics[`live.lag.${run}`].lag, 3);
  });
});
