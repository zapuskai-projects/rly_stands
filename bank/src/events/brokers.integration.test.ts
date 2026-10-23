import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect } from 'amqplib';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { clearedTopics, clearKafkaTopics } from './clear-topics';
import { handleCreatedMessage, handleDecisionMessage, handleNotificationMessage } from './handlers';
import { startOutboxPublisher, type BackgroundLoop } from './outbox.publisher';
import { createDecisionProducer, type DecisionProducer } from './decision-sender';
import { createKafka, KafkaTransport, startKafkaConsumer } from './kafka';
import { assertNotificationTopology, RabbitTransport, startNotificationConsumer } from './rabbit';
import { configureTopics } from './topics';
import { RoutingTransport } from './transport';
import { pick, startHarness, type Harness } from '../testing/harness';
import { checkLedger } from '../testing/ledger-check';
import { accountOf, marksOf, NIGHT_MOSCOW, PHONES, phoneTransfer, sendTransfer, setDefects } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const KAFKA = process.env.TEST_KAFKA_BROKERS;
const RABBIT = process.env.TEST_RABBITMQ_URL;
const READY = Boolean(DATABASE_URL && KAFKA && RABBIT);

describe('обмен через настоящие Kafka и RabbitMQ', { skip: READY ? false : 'нужны TEST_DATABASE_URL, TEST_KAFKA_BROKERS и TEST_RABBITMQ_URL' }, () => {
  let h: Harness;
  let prefix: string;
  const loops: BackgroundLoop[] = [];
  let producer: DecisionProducer;
  let kafkaTransport: KafkaTransport;
  let rabbitTransport: RabbitTransport;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NIGHT_MOSCOW);
    prefix = `t${randomBytes(4).toString('hex')}.`;
    const topics = configureTopics(prefix);
    const kafka = createKafka((KAFKA as string).split(','), `bank-test-${prefix}`);
    kafkaTransport = new KafkaTransport(kafka, [topics.paymentsCreated, topics.statusChanged, topics.antifraudDecisions]);
    rabbitTransport = new RabbitTransport(RABBIT as string, topics);
    producer = createDecisionProducer(kafka, topics.antifraudDecisions);
    loops.push(
      startOutboxPublisher(h.pool, new RoutingTransport(kafkaTransport, rabbitTransport), { intervalMs: 50, clock: h.clock }),
      startKafkaConsumer({ kafka, groupId: `${prefix}antifraud`, topic: topics.paymentsCreated, onMessage: (message) => handleCreatedMessage(h.deps, producer.send, message) }),
      startKafkaConsumer({ kafka, groupId: `${prefix}core`, topic: topics.antifraudDecisions, onMessage: (message) => handleDecisionMessage(h.deps, message) }),
      startNotificationConsumer({ url: RABBIT as string, names: topics, onMessage: (message) => handleNotificationMessage(h.deps, message.body, message.headers) }),
    );
  });

  afterEach(async () => {
    for (const loop of loops.splice(0)) await loop.stop();
    await producer.close();
    await kafkaTransport.close();
    await rabbitTransport.close();
    const topics = configureTopics(prefix);
    const kafka = createKafka((KAFKA as string).split(','), 'bank-test-cleanup');
    const admin = kafka.admin();
    await admin.connect();
    await admin.deleteTopics({ topics: [topics.paymentsCreated, topics.statusChanged, topics.antifraudDecisions] }).catch(() => undefined);
    await admin.disconnect();
    const connection = await connect(RABBIT as string);
    const channel = await connection.createChannel();
    for (const queue of [topics.notificationsQueue, topics.notificationsDlq]) await channel.deleteQueue(queue).catch(() => undefined);
    await connection.close();
    configureTopics('');
    await h.close();
  });

  async function waitForStatus(token: string, id: string, expected: string): Promise<string> {
    const deadline = Date.now() + 40_000;
    let status = '';
    while (Date.now() < deadline) {
      status = String(pick((await h.api(token, 'GET', `/api/v1/operations/${id}`)).body, 'status'));
      if (status === expected) return status;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return status;
  }

  it('ночной перевод проходит путь Kafka → антифрод → Kafka → ручная проверка → RabbitMQ → журнал уведомлений', async () => {
    const anna = await h.login(PHONES.ANNA);
    const from = await accountOf(h, anna);
    const created = await sendTransfer(h, anna, 'broker-key-0001', phoneTransfer(from.number, PHONES.PETR, 1_500_000));
    const id = String(pick(created.body, 'id'));
    assert.equal(await waitForStatus(anna, id, 'ON_REVIEW'), 'ON_REVIEW');

    const approved = await h.api(await h.operatorLogin(), 'POST', `/api/v1/office/reviews/${id}/approve`);
    assert.equal(approved.status, 200);
    assert.equal(await waitForStatus(anna, id, 'COMPLETED'), 'COMPLETED');

    const deadline = Date.now() + 20_000;
    let total = 0;
    while (total < 4 && Date.now() < deadline) {
      total = (await h.pool.query('SELECT 1 FROM notifications WHERE operation_id = $1', [id])).rowCount ?? 0;
      if (total < 4) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(total, 4);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  it('очередь уведомлений объявлена с DLX, испорченное сообщение попадает в очередь недоставленных', async () => {
    const topics = configureTopics(prefix);
    const connection = await connect(RABBIT as string);
    const channel = await connection.createConfirmChannel();
    await assertNotificationTopology(channel, topics);
    const queue = await channel.checkQueue(topics.notificationsQueue);
    assert.equal(queue.queue, topics.notificationsQueue);
    channel.publish(topics.notificationsExchange, 'notification', Buffer.from('{"messageId":"плохой"}'), { persistent: true, headers: { operationId: 'poison', requestId: 'req-poison-1' } });
    await channel.waitForConfirms();
    const deadline = Date.now() + 15_000;
    let dead = false;
    while (!dead && Date.now() < deadline) {
      const message = await channel.get(topics.notificationsDlq, { noAck: true });
      dead = message !== false && message.content.toString().includes('плохой');
      if (!dead) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await connection.close();
    assert.equal(dead, true);
  });

  async function readCreatedEvent(operationId: string): Promise<{ amount: number; fee: number } | null> {
    const topics = configureTopics(prefix);
    const kafka = createKafka((KAFKA as string).split(','), `bank-test-reader-${prefix}`);
    const consumer = kafka.consumer({ groupId: `${prefix}reader-${operationId.slice(0, 8)}` });
    let found: { amount: number; fee: number } | null = null;
    await consumer.connect();
    await consumer.subscribe({ topic: topics.paymentsCreated, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ message }) => {
        const payload = JSON.parse(message.value?.toString() ?? '{}') as { operationId?: string; amount: number; fee: number };
        if (payload.operationId === operationId) found = { amount: payload.amount, fee: payload.fee };
      },
    });
    const deadline = Date.now() + 15_000;
    while (!found && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    await consumer.disconnect();
    return found;
  }

  it('kafka-amount-mismatch: в настоящем топике bank.payments.created сумма в копейках без сбоя и в рублях с дробью со сбоем, операция и проводки верные, пометка есть', async () => {
    const anna = await h.login(PHONES.ANNA);
    const from = await accountOf(h, anna);

    const honest = await sendTransfer(h, anna, 'amount-key-0001', phoneTransfer(from.number, PHONES.PETR, 150_050));
    const honestId = String(pick(honest.body, 'id'));
    assert.equal(await waitForStatus(anna, honestId, 'COMPLETED'), 'COMPLETED');
    assert.deepEqual(await readCreatedEvent(honestId), { amount: 150_050, fee: 0 });
    assert.deepEqual(await marksOf(h, honest), []);

    await setDefects(h, ['kafka-amount-mismatch']);
    const broken = await sendTransfer(h, anna, 'amount-key-0002', phoneTransfer(from.number, PHONES.PETR, 150_050));
    const brokenId = String(pick(broken.body, 'id'));
    assert.equal(await waitForStatus(anna, brokenId, 'COMPLETED'), 'COMPLETED');
    assert.deepEqual(await readCreatedEvent(brokenId), { amount: 1500.5, fee: 0 });
    assert.equal(pick((await h.api(anna, 'GET', `/api/v1/operations/${brokenId}`)).body, 'amount'), 150_050);
    const marks = await marksOf(h, broken);
    assert.deepEqual(marks.map((mark) => [mark.code, mark.details.expected, mark.details.actual]), [['kafka-amount-mismatch', 150_050, 1500.5]]);
    assert.deepEqual((await checkLedger(h.pool)).mismatchedAccounts, []);
  });

  async function readable(topic: string): Promise<number> {
    const admin = createKafka((KAFKA as string).split(','), `bank-test-offsets-${prefix}`).admin();
    await admin.connect();
    try {
      const offsets = await admin.fetchTopicOffsets(topic);
      return offsets.reduce((sum, item) => sum + (Number(item.high) - Number(item.low)), 0);
    } finally {
      await admin.disconnect();
    }
  }

  async function waitForReadable(topic: string, expected: number): Promise<number> {
    const deadline = Date.now() + 20_000;
    let count = await readable(topic);
    while (count !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      count = await readable(topic);
    }
    return count;
  }

  it('очистка топиков банка убирает записи до текущего конца, а переводы после неё идут через Kafka как обычно', async () => {
    const topics = configureTopics(prefix);
    const anna = await h.login(PHONES.ANNA);
    const from = await accountOf(h, anna);
    const first = await sendTransfer(h, anna, 'clear-key-0001', phoneTransfer(from.number, PHONES.PETR, 150_050));
    assert.equal(await waitForStatus(anna, String(pick(first.body, 'id')), 'COMPLETED'), 'COMPLETED');
    assert.equal(await waitForReadable(topics.paymentsCreated, 1), 1);
    assert.equal(await waitForReadable(topics.statusChanged, 3), 3);
    assert.equal(await waitForReadable(topics.antifraudDecisions, 1), 1);

    const kafka = createKafka((KAFKA as string).split(','), `bank-test-clear-${prefix}`);
    await clearKafkaTopics(kafka, clearedTopics(topics));
    for (const topic of clearedTopics(topics)) assert.equal(await readable(topic), 0, topic);

    const second = await sendTransfer(h, anna, 'clear-key-0002', phoneTransfer(from.number, PHONES.PETR, 150_050));
    assert.equal(await waitForStatus(anna, String(pick(second.body, 'id')), 'COMPLETED'), 'COMPLETED');
    assert.equal(await waitForReadable(topics.paymentsCreated, 1), 1);
    assert.equal(await waitForReadable(topics.antifraudDecisions, 1), 1);
    assert.equal((await readCreatedEvent(String(pick(second.body, 'id'))))?.amount, 150_050);
  });

  it('очистка не падает, если топиков ещё нет', async () => {
    const kafka = createKafka((KAFKA as string).split(','), `bank-test-clear-${prefix}`);
    await clearKafkaTopics(kafka, [`${prefix}never.created`]);
  });

  it('events.duplicate-delivery: в настоящем топике событие операции с нечётным номером лежит дважды, без сбоя один раз', async () => {
    const topics = configureTopics(prefix);
    const anna = await h.login(PHONES.ANNA);
    const from = await accountOf(h, anna);
    const send = async (key: string) => {
      const created = await sendTransfer(h, anna, key, phoneTransfer(from.number, PHONES.PETR, 100_000));
      assert.equal(await waitForStatus(anna, String(pick(created.body, 'id')), 'COMPLETED'), 'COMPLETED');
    };
    await send('twice-key-0001');
    await send('twice-key-0002');
    assert.equal(await waitForReadable(topics.paymentsCreated, 2), 2);
    assert.equal(await waitForReadable(topics.statusChanged, 6), 6);

    await setDefects(h, ['events.duplicate-delivery']);
    await send('twice-key-0003');
    await send('twice-key-0004');
    assert.equal(await waitForReadable(topics.paymentsCreated, 5), 5);
    assert.equal(await waitForReadable(topics.statusChanged, 15), 15);
  });
});

