import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAsyncApiSamples, describeAsyncApi } from './asyncapi';
import { describeProto } from './grpc';

const ASYNCAPI = `asyncapi: 3.0.0
info:
  title: k3x9ab События документов
  version: 1.0.0
channels:
  documentsCreated:
    address: documents.created
    messages:
      DocumentCreated:
        payload:
          type: object
          properties:
            id:
              type: string
            amount:
              type: number
operations:
  publishCreated:
    action: send
    channel:
      $ref: '#/channels/documentsCreated'
`;

const PROTO = `syntax = "proto3";
package k3x9ab.documents.v1;

service Registry {
  rpc Register (RegisterRequest) returns (RegisterReply);
  rpc Watch (WatchRequest) returns (stream RegisterReply);
}

message RegisterRequest {
  string title = 1;
  repeated string tags = 2;
  map<string, string> meta = 3;
}
message RegisterReply { int64 id = 1; }
message WatchRequest {}
`;

describe('asyncapi.describe', () => {
  it('каналы, сообщения с полями и операции', async () => {
    const facts = await describeAsyncApi(ASYNCAPI);
    assert.equal(facts.parsed, true);
    assert.equal(facts.info.title, 'k3x9ab События документов');
    assert.deepEqual(facts.channels, [
      {
        name: 'documents.created',
        messages: [
          {
            name: 'DocumentCreated',
            fields: [{ name: 'id', type: 'string', enum: [] }, { name: 'amount', type: 'number', enum: [] }],
            fieldNames: ['id', 'amount'],
            kafkaKey: null,
          },
        ],
      },
    ]);
    assert.deepEqual(facts.operations, [{ id: 'publishCreated', action: 'send', channel: 'documents.created' }]);
  });

  it('имена полей включают вложенные объекты и элементы массивов', async () => {
    const facts = await describeAsyncApi(`asyncapi: 3.0.0
info:
  title: События
  version: 1.0.0
channels:
  orders:
    address: orders.created
    messages:
      OrderCreated:
        payload:
          type: object
          properties:
            id:
              type: string
            customer:
              type: object
              properties:
                phone:
                  type: string
            items:
              type: array
              items:
                type: object
                properties:
                  sku:
                    type: string
operations:
  publishOrder:
    action: send
    channel:
      $ref: '#/channels/orders'
`);
    assert.deepEqual(facts.channels[0]?.messages[0]?.fieldNames, ['id', 'customer', 'customer.phone', 'items', 'items[].sku']);
  });

  it('допустимые значения поля попадают в факты', async () => {
    const facts = await describeAsyncApi(`asyncapi: 2.6.0
info:
  title: События
  version: 1.0.0
channels:
  bank.autopayments.executed:
    subscribe:
      message:
        name: AutopaymentExecuted
        payload:
          type: object
          properties:
            outcome:
              type: string
              enum: [EXECUTED, FAILED]
            reasonCode:
              type: [string, 'null']
`);
    assert.deepEqual(facts.channels[0]?.messages[0]?.fields, [
      { name: 'outcome', type: 'string', enum: ['EXECUTED', 'FAILED'] },
      { name: 'reasonCode', type: 'string|null', enum: [] },
    ]);
  });

  it('привязка Kafka key: тип, описание и признак «ключ — номер клиента»', async () => {
    const document = (key: string) => `asyncapi: 2.6.0
info:
  title: События
  version: 1.0.0
channels:
  bank.payments.created:
    subscribe:
      message:
        name: PaymentCreated
        bindings:
          kafka:
${key}
        payload:
          type: object
          properties:
            amount:
              type: integer
`;
    const about = await describeAsyncApi(
      document('            key:\n              type: string\n              description: Номер клиента'),
    );
    assert.deepEqual(about.channels[0]?.messages[0]?.kafkaKey, {
      type: 'string',
      description: 'Номер клиента',
      aboutClient: true,
    });
    const other = await describeAsyncApi(document('            key:\n              type: string\n              description: Идентификатор события'));
    assert.equal(other.channels[0]?.messages[0]?.kafkaKey?.aboutClient, false);
    const none = await describeAsyncApi(document('            groupId:\n              type: string'));
    assert.equal(none.channels[0]?.messages[0]?.kafkaKey, null);
  });

  it('документ без обязательных полей и не AsyncAPI дают ошибки', async () => {
    const incomplete = await describeAsyncApi('asyncapi: 3.0.0\ninfo: {}\n');
    assert.equal(incomplete.parsed, false);
    assert.ok(incomplete.errors.length > 0);
    const other = await describeAsyncApi('title: x');
    assert.equal(other.parsed, false);
  });
});

describe('asyncapi.samples', () => {
  const document = (operationId: string) => `asyncapi: 2.6.0
info:
  title: События
  version: 1.0.0
channels:
  bank.autopayments.executed:
    subscribe:
      message:
        name: AutopaymentExecuted
        payload:
          type: object
          additionalProperties: false
          required: [outcome, operationId]
          properties:
            outcome:
              type: string
              enum: [EXECUTED, FAILED]
            operationId:
              ${operationId}
`;
  const executed = { data: { outcome: 'EXECUTED', operationId: 'op-1' }, expectValid: true };
  const failedAttempt = { data: { outcome: 'FAILED', operationId: null }, expectValid: true };

  it('события с null проходят, если поле описано с null', async () => {
    const facts = await checkAsyncApiSamples(document('type: [string, "null"]'), 'bank.autopayments.executed', [executed, failedAttempt]);
    assert.equal(facts.parsed, true);
    assert.equal(facts.sampleCount, 2);
    assert.equal(facts.allOk, true);
  });

  it('поле без null не пропускает событие неудачной попытки и называет причину', async () => {
    const facts = await checkAsyncApiSamples(document('type: string'), 'bank.autopayments.executed', [executed, failedAttempt]);
    assert.equal(facts.allOk, false);
    assert.deepEqual(facts.results.map((item) => item.ok), [true, false]);
    assert.match(facts.results[1]?.errors.join(' ') ?? '', /operationId/);
  });

  it('неизвестное значение перечисления и лишнее поле не проходят', async () => {
    const facts = await checkAsyncApiSamples(document('type: [string, "null"]'), undefined, [
      { data: { outcome: 'DONE', operationId: null }, expectValid: true },
      { data: { outcome: 'EXECUTED', operationId: null, extra: 1 }, expectValid: true },
    ]);
    assert.deepEqual(facts.results.map((item) => item.ok), [false, false]);
  });

  it('нет такого канала или документ не разбирается — ни один пример не проходит', async () => {
    const noChannel = await checkAsyncApiSamples(document('type: string'), 'bank.other', [executed]);
    assert.equal(noChannel.allOk, false);
    assert.match(noChannel.errors.join(' '), /bank\.other/);
    const broken = await checkAsyncApiSamples('title: x', undefined, [executed]);
    assert.equal(broken.parsed, false);
    assert.equal(broken.allOk, false);
  });
});

describe('grpc.protoDescribe', () => {
  it('пакет, сервисы со стримингом, сообщения с типами и номерами', () => {
    const facts = describeProto(PROTO);
    assert.equal(facts.parsed, true);
    assert.equal(facts.package, 'k3x9ab.documents.v1');
    assert.deepEqual(facts.services, [
      {
        name: 'Registry',
        methods: [
          { name: 'Register', input: 'RegisterRequest', output: 'RegisterReply', clientStreaming: false, serverStreaming: false },
          { name: 'Watch', input: 'WatchRequest', output: 'RegisterReply', clientStreaming: false, serverStreaming: true },
        ],
      },
    ]);
    const request = facts.messages.find((message) => message.name === 'RegisterRequest');
    assert.deepEqual(request?.fields, [
      { name: 'title', type: 'string', number: 1, repeated: false },
      { name: 'tags', type: 'string', number: 2, repeated: true },
      { name: 'meta', type: 'map<string,string>', number: 3, repeated: false },
    ]);
  });

  it('перечисления с значениями, в том числе вложенные; тип поля — имя перечисления', () => {
    const facts = describeProto(`syntax = "proto3";
package k3x9ab.documents.v1;
enum DocumentStatus {
  DOCUMENT_STATUS_UNSPECIFIED = 0;
  DOCUMENT_STATUS_REGISTERED = 1;
}
message Reply {
  DocumentStatus status = 1;
  enum Channel { CHANNEL_UNSPECIFIED = 0; CHANNEL_MAIL = 2; }
  Channel channel = 2;
}
`);
    assert.deepEqual(facts.enums, [
      {
        name: 'DocumentStatus',
        values: [
          { name: 'DOCUMENT_STATUS_UNSPECIFIED', number: 0 },
          { name: 'DOCUMENT_STATUS_REGISTERED', number: 1 },
        ],
      },
      {
        name: 'Channel',
        values: [
          { name: 'CHANNEL_UNSPECIFIED', number: 0 },
          { name: 'CHANNEL_MAIL', number: 2 },
        ],
      },
    ]);
    assert.equal(facts.messages[0]?.fields[0]?.type, 'DocumentStatus');
    assert.deepEqual(describeProto('syntax = "proto3";\nmessage A { string = 1; }').enums, []);
  });

  it('синтаксическая ошибка даёт parsed=false', () => {
    const facts = describeProto('syntax = "proto3";\nmessage A { string = 1; }');
    assert.equal(facts.parsed, false);
    assert.ok(facts.errors.length > 0);
  });
});
