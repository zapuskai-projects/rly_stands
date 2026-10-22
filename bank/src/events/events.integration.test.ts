import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { deliverNotification } from '../notifications/delivery';
import { loadAsyncApi } from '../testing/asyncapi';
import { pick, startHarness, type Harness, type PublishedEvent } from '../testing/harness';
import { accountOf, NOON_MOSCOW, PHONES, phoneTransfer, sendTransfer } from '../testing/scenarios';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const { ANNA, PETR } = PHONES;
const REQUEST_ID = 'req-events-0001';

describe('события платежей и уведомления', { skip: DATABASE_URL ? false : 'нужна TEST_DATABASE_URL' }, () => {
  let h: Harness;
  let operationId: string;
  let operationNumber: string;

  beforeEach(async () => {
    h = await startHarness(DATABASE_URL as string, NOON_MOSCOW);
    const anna = await h.login(ANNA);
    const from = await accountOf(h, anna);
    const created = await sendTransfer(h, anna, 'events-key-0001', phoneTransfer(from.number, PETR, 150_000), { 'X-Request-Id': REQUEST_ID });
    await h.drain();
    operationId = String(pick(created.body, 'id'));
    operationNumber = String(pick(created.body, 'number'));
  });

  afterEach(async () => {
    await h.close();
  });

  const kafkaEvents = (): PublishedEvent[] => h.events.filter((event) => event.topic.startsWith('bank.') && !event.topic.endsWith('notifications'));
  const onTopic = (topic: string): PublishedEvent[] => h.events.filter((event) => event.topic === topic);

  it('каждое событие Kafka несёт ключ — номер клиента, операцию и сквозной номер запроса в заголовках', () => {
    assert.ok(kafkaEvents().length >= 5);
    for (const event of kafkaEvents()) {
      assert.equal(event.key, '10000001');
      assert.equal(event.headers.operationId, operationId);
      assert.equal(event.headers.requestId, REQUEST_ID);
    }
  });

  it('создание, смены статусов и решение приходят в своих топиках в порядке жизни операции', () => {
    assert.equal(onTopic('bank.payments.created').length, 1);
    const transitions = onTopic('bank.payments.status-changed').map((event) => {
      const payload = event.payload as { previousStatus: string; status: string };
      return `${payload.previousStatus}>${payload.status}`;
    });
    assert.deepEqual(transitions, ['CREATED>CHECKING', 'CHECKING>PROCESSING', 'PROCESSING>COMPLETED']);
    const decisions = onTopic('bank.antifraud.decisions');
    assert.equal(decisions.length, 1);
    assert.equal((decisions[0]?.payload as { decision: string }).decision, 'APPROVE');
  });

  it('сумма в событии — копейки, время — московское', () => {
    const payload = onTopic('bank.payments.created')[0]?.payload as { amount: number; fee: number; createdAt: string; operationNumber: string };
    assert.equal(payload.amount, 150_000);
    assert.equal(payload.fee, 0);
    assert.equal(payload.operationNumber, operationNumber);
    assert.match(payload.createdAt, /^2026-10-20T12:00:00\.000\+03:00$/);
  });

  it('все события соответствуют AsyncAPI-контракту', () => {
    const contract = loadAsyncApi();
    const checks: [string, string][] = [
      ['bank.payments.created', 'bank.payments.created'],
      ['bank.payments.status-changed', 'bank.payments.status-changed'],
      ['bank.antifraud.decisions', 'bank.antifraud.decisions'],
      ['bank.notifications', 'bank.notifications'],
    ];
    for (const [topic, channel] of checks) {
      const events = onTopic(topic);
      assert.ok(events.length > 0, topic);
      const validate = contract.payloadValidator(channel);
      for (const event of events) {
        const result = validate(event.payload);
        assert.equal(result.ok, true, `${topic}: ${result.issues.join('; ')}`);
      }
    }
    assert.deepEqual(contract.messageHeaders('bank.payments.created'), ['operationId', 'requestId']);
  });

  it('контракт описывает ровно те каналы, которые использует банк', () => {
    assert.deepEqual(loadAsyncApi().channels.sort(), [
      'bank.antifraud.decisions',
      'bank.notifications',
      'bank.payments.created',
      'bank.payments.status-changed',
    ]);
  });

  it('уведомления: четыре сообщения после COMPLETED, повторная доставка не создаёт дубль', async () => {
    const messages = onTopic('bank.notifications');
    assert.equal(messages.length, 4);
    assert.equal(messages[0]?.key, 'notification');
    assert.equal(messages[0]?.headers.operationId, operationId);
    const before = await h.pool.query('SELECT COUNT(*) AS total FROM notifications WHERE operation_id = $1', [operationId]);
    assert.equal(before.rows[0].total, 4n);
    assert.equal(await deliverNotification(h.pool, h.clock, messages[0]?.payload), 'DUPLICATE');
    const after = await h.pool.query('SELECT COUNT(*) AS total FROM notifications WHERE operation_id = $1', [operationId]);
    assert.equal(after.rows[0].total, 4n);
  });

  it('испорченное уведомление не записывается и уходит в очередь недоставленных', async () => {
    await assert.rejects(deliverNotification(h.pool, h.clock, { messageId: 'не uuid', text: '' }));
    await assert.rejects(deliverNotification(h.pool, h.clock, null));
    const total = await h.pool.query('SELECT COUNT(*) AS total FROM notifications WHERE operation_id = $1', [operationId]);
    assert.equal(total.rows[0].total, 4n);
  });

  it('текст СМС отправителю называет сумму, получателя и номер операции', async () => {
    const sms = await h.pool.query("SELECT text FROM notifications WHERE operation_id = $1 AND kind = 'TRANSFER_COMPLETED' AND channel = 'SMS'", [operationId]);
    assert.equal(sms.rows[0].text, `ЗапускБанк: перевод 1 500,00 ₽ получателю Пётр И. выполнен. Операция ${operationNumber}.`);
    const sandbox = await h.api(null, 'GET', `/api/v1/sandbox/sms?phone=${encodeURIComponent(ANNA)}&limit=1`);
    assert.equal(pick(sandbox.body, 'items.0.kind'), 'TRANSFER_COMPLETED');
  });
});
