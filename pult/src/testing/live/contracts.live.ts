import assert from 'node:assert/strict';
import { it } from 'node:test';
import { READINESS } from '../../modules/readiness';
import { liveSuite } from './support';

type Facts = Record<string, any>;

const OPENAPI_BASE = `openapi: 3.0.3
info:
  title: Заказы
  version: 1.0.0
paths:
  /orders:
    get:
      operationId: listOrders
      responses:
        '200':
          description: Список заказов
  /orders/{id}:
    get:
      operationId: getOrder
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: Заказ
`;

const OPENAPI_REVISION = `openapi: 3.0.3
info:
  title: Заказы
  version: 1.1.0
paths:
  /orders:
    get:
      operationId: listOrders
      responses:
        '200':
          description: Список заказов
`;

const OPENAPI_BROKEN = `openapi: 3.0.3
info:
  title: Заказы
  version: 1.0.0
paths:
  /orders:
    get:
      operationId: listOrders
`;

const PROTO_BASE = `syntax = "proto3";
package orders.v1;

service OrderService {
  rpc GetOrder(GetOrderRequest) returns (GetOrderResponse);
}

message GetOrderRequest {
  string id = 1;
}

message GetOrderResponse {
  string id = 1;
  string status = 2;
}
`;

const PROTO_REVISION = PROTO_BASE.replace('  string status = 2;\n', '');
const PROTO_BAD_NAMES = PROTO_BASE.replace('message GetOrderResponse', 'message get_order_response').replace(
  'returns (GetOrderResponse)',
  'returns (get_order_response)',
);

const SEQUENCE_OK = `@startuml
title Оформление заказа
actor Клиент
Клиент -> Магазин : Создать заказ
Магазин --> Клиент : Номер заказа
@enduml
`;

const SEQUENCE_BLOCKS = `@startuml
title Согласование
participant sed
participant lawyer
participant accounting
participant initiator
par
  sed -> lawyer : Согласовать
else
  sed -> accounting : Согласовать
end
alt Отказ
  sed -> initiator : Возврат
end
@enduml
`;

const PROTO_REGISTRY = `syntax = "proto3";

package live.registry.v1;

service DocumentRegistry {
  rpc RegisterDocument(RegisterDocumentRequest) returns (RegisterDocumentResponse);
}

enum DocumentStatus {
  DOCUMENT_STATUS_UNSPECIFIED = 0;
  DOCUMENT_STATUS_REGISTERED = 1;
}

message RegisterDocumentRequest {
  string doc_type = 1;
  int32 sheets = 2;
}

message RegisterDocumentResponse {
  string reg_number = 1;
  DocumentStatus status = 2;
}
`;

const SEQUENCE_BROKEN = `@startuml
title Оформление заказа
Клиент -> Магазин : Создать заказ
if (
@enduml
`;

const CLASS_OK = `@startuml
title Заказ
class Order {
  +id: string
}
class Customer
Customer "1" --> "*" Order
@enduml
`;

const STATE_OK = `@startuml
title Статусы
[*] --> New
New --> Paid : оплата
Paid --> [*]
@enduml
`;

const XSD = `<?xml version="1.0"?>
<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:element name="order">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="number" type="xs:string"/>
        <xs:element name="amount" type="xs:decimal"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
</xs:schema>`;

liveSuite('contracts', (READINESS.contracts ?? []).slice(0, 1), 'Контракты и диаграммы: проверки с настоящими утилитами', ({ probe, write }) => {
  it('PlantUML-сервер принимает верные диаграммы всех видов и разбирает факты', async () => {
    write('sequence.puml', SEQUENCE_OK);
    write('class.puml', CLASS_OK);
    write('state.puml', STATE_OK);
    const sequence = await probe<Facts>('plantuml.sequence', { file: 'sequence.puml' });
    assert.deepEqual(sequence.syntaxErrors, []);
    assert.equal(sequence.title, 'Оформление заказа');
    assert.deepEqual(sequence.participants.map((item: Facts) => item.name), ['Клиент', 'Магазин']);
    assert.equal(sequence.messages.length, 2);
    const classes = await probe<Facts>('plantuml.class', { file: 'class.puml' });
    assert.deepEqual(classes.syntaxErrors, []);
    assert.deepEqual(classes.classes.map((item: Facts) => item.name).sort(), ['Customer', 'Order']);
    const states = await probe<Facts>('plantuml.state', { file: 'state.puml' });
    assert.deepEqual(states.syntaxErrors, []);
    assert.deepEqual(states.edges, ['[*] -> New', 'New -> Paid', 'Paid -> [*]']);
  });

  it('блоки диаграммы последовательности: сообщения внутри блока и блок у каждого сообщения', async () => {
    write('blocks.puml', SEQUENCE_BLOCKS);
    const facts = await probe<Facts>('plantuml.sequence', { file: 'blocks.puml' });
    assert.deepEqual(facts.syntaxErrors, []);
    const par = facts.blocks.find((block: Facts) => block.kind === 'par');
    assert.deepEqual(par.messages.map((message: Facts) => message.to), ['lawyer', 'accounting']);
    const alt = facts.blocks.find((block: Facts) => block.kind === 'alt');
    assert.deepEqual(alt.messages.map((message: Facts) => [message.from, message.to]), [['sed', 'initiator']]);
    assert.deepEqual(facts.messages.map((message: Facts) => message.block?.kind), ['par', 'par', 'alt']);
  });

  it('синтаксическая ошибка находится сервером со строкой, нет файла — понятная ошибка', async () => {
    write('broken.puml', SEQUENCE_BROKEN);
    const broken = await probe<Facts>('plantuml.sequence', { file: 'broken.puml' });
    assert.ok(broken.syntaxErrors.length > 0);
    assert.match(broken.syntaxErrors.join(' '), /строка \d+/);
    const absent = await probe<Facts>('plantuml.sequence', { file: 'absent.puml' });
    assert.match(absent.syntaxErrors[0], /absent\.puml/);
    assert.deepEqual(absent.participants, []);
  });

  it('Redocly: верный документ без ошибок, документ без ответов — с ошибкой, нет файла — ошибка файла', async () => {
    write('openapi.yaml', OPENAPI_BASE);
    write('openapi-broken.yaml', OPENAPI_BROKEN);
    const ok = await probe<Facts>('openapi.lint', { file: 'openapi.yaml' });
    assert.equal(ok.errors, 0);
    const broken = await probe<Facts>('openapi.lint', { file: 'openapi-broken.yaml' });
    assert.ok(broken.errors >= 1);
    assert.ok(broken.problems.some((problem: Facts) => problem.severity === 'error' && problem.message));
    const absent = await probe<Facts>('openapi.lint', { file: 'absent.yaml' });
    assert.equal(absent.errors, 1);
    assert.equal(absent.problems[0].rule, 'file');
  });

  it('oasdiff: удалённая операция ломает совместимость, одинаковые версии — нет, нет файла — ошибка', async () => {
    write('base.yaml', OPENAPI_BASE);
    write('revision.yaml', OPENAPI_REVISION);
    const changed = await probe<Facts>('openapi.breaking', { file: 'revision.yaml', baseFile: 'base.yaml' });
    assert.equal(changed.error, null);
    assert.ok(changed.count >= 1);
    assert.ok(changed.breaking.some((item: Facts) => /path/i.test(item.id)));
    const same = await probe<Facts>('openapi.breaking', { file: 'base.yaml', baseFile: 'base.yaml' });
    assert.deepEqual(same, { count: 0, breaking: [], error: null });
    const absent = await probe<Facts>('openapi.breaking', { file: 'revision.yaml', baseFile: 'absent.yaml' });
    assert.match(absent.error, /absent\.yaml/);
  });

  it('buf: правила именования и ломающие изменения в proto', async () => {
    write('order.proto', PROTO_BASE);
    write('order-bad.proto', PROTO_BAD_NAMES);
    write('order-new.proto', PROTO_REVISION);
    const clean = await probe<Facts>('grpc.protoLint', { file: 'order.proto' });
    assert.equal(clean.count, 0, JSON.stringify(clean.problems));
    const bad = await probe<Facts>('grpc.protoLint', { file: 'order-bad.proto' });
    assert.ok(bad.count >= 1);
    assert.ok(bad.problems.every((problem: Facts) => problem.rule && problem.message));
    const breaking = await probe<Facts>('grpc.protoBreaking', { file: 'order-new.proto', baseProto: 'order.proto' });
    assert.ok(breaking.count >= 1);
    assert.deepEqual(await probe('grpc.protoBreaking', { file: 'order.proto', baseProto: 'order.proto' }), { count: 0, problems: [] });
    assert.equal((await probe<Facts>('grpc.protoLint', { file: 'absent.proto' })).problems[0].rule, 'FILE');
  });

  it('proto: перечисления в фактах, имя сервиса без суффикса Service линтер принимает', async () => {
    write('registry.proto', PROTO_REGISTRY);
    const lint = await probe<Facts>('grpc.protoLint', { file: 'registry.proto' });
    assert.equal(lint.count, 0, JSON.stringify(lint.problems));
    const facts = await probe<Facts>('grpc.protoDescribe', { file: 'registry.proto' });
    assert.equal(facts.parsed, true);
    assert.deepEqual(facts.enums, [
      {
        name: 'DocumentStatus',
        values: [
          { name: 'DOCUMENT_STATUS_UNSPECIFIED', number: 0 },
          { name: 'DOCUMENT_STATUS_REGISTERED', number: 1 },
        ],
      },
    ]);
    const response = facts.messages.find((message: Facts) => message.name === 'RegisterDocumentResponse');
    assert.equal(response.fields.find((field: Facts) => field.name === 'status').type, 'DocumentStatus');
  });

  it('xmllint: примеры по XSD и значения по XPath', async () => {
    write('order.xsd', XSD);
    write('order.xml', '<order><number>K-1</number><amount>10.5</amount></order>');
    const samples = await probe<Facts>('xsd.samples', {
      xsdFile: 'order.xsd',
      samples: [
        { xml: '<order><number>K-1</number><amount>10.5</amount></order>', expectValid: true },
        { xml: '<order><number>K-2</number></order>', expectValid: false },
      ],
    });
    assert.equal(samples.allOk, true);
    assert.deepEqual(samples.results.map((item: Facts) => item.valid), [true, false]);
    const xpath = await probe<Facts>('xml.xpath', { file: 'order.xml', xpath: '/order/amount' });
    assert.equal(xpath.parsed, true);
    assert.equal(xpath.count, 1);
    assert.deepEqual(xpath.values, ['10.5']);
    const bad = await probe<Facts>('xml.xpath', { file: 'order.xml', xpath: '/order/[' });
    assert.equal(bad.parsed, false);
  });
});

const ER_DIAGRAM = `@startuml
title Модель данных
entity "clients" as clients {
  * id : uuid <<PK>>
  --
  full_name : text
}
entity "accounts" as accounts {
  * id : uuid <<PK>>
  * client_id : uuid <<FK>>
  balance_kop : numeric(19,2)
}
entity "postings" as postings {
  * id : bigint <<PK>>
  * debit_account_id : uuid <<FK>>
  * credit_account_id : uuid <<FK>>
}
accounts }o--|| clients
postings }o--|| accounts : debit
@enduml
`;

const JUNIT_REPORT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" tests="4" failures="1">
<testcase classname="tests.test_limit" name="test_daily_limit[a]"/>
<testcase classname="tests.test_limit" name="test_daily_limit[b]"/>
<testcase classname="tests.test_limit" name="test_daily_limit[c]"><failure message="assert 1 == 2">trace</failure></testcase>
<testcase classname="tests.test_login" name="test_login"/>
</testsuite></testsuites>`;

liveSuite('contracts', (READINESS.contracts ?? []).slice(0, 1), 'Контракты: ER-диаграмма и отчёты JUnit', ({ probe, write }) => {
  it('ER-диаграмма: сущности, ключи, связи с кратностью и пары проходят настоящий сервер PlantUML', async () => {
    write('er.puml', ER_DIAGRAM);
    const facts = await probe<Facts>('plantuml.class', { file: 'er.puml' });
    assert.deepEqual(facts.syntaxErrors, []);
    assert.deepEqual(facts.classes.map((item: Facts) => [item.name, item.kind]), [
      ['clients', 'entity'],
      ['accounts', 'entity'],
      ['postings', 'entity'],
    ]);
    const accounts = facts.classes.find((item: Facts) => item.name === 'accounts');
    assert.deepEqual(accounts.attributes.filter((item: Facts) => item.fk).map((item: Facts) => item.name), ['client_id']);
    assert.equal(accounts.attributes.find((item: Facts) => item.name === 'balance_kop').type, 'numeric(19,2)');
    assert.deepEqual(facts.linkPairs, ['accounts--clients', 'accounts--postings']);
    assert.equal(facts.relations[1].fromMultiplicity, '0..*');
    assert.equal(facts.relations[1].toMultiplicity, '1');
    write('er-broken.puml', '@startuml\nentity a {\n* id\n@enduml');
    assert.notDeepEqual((await probe<Facts>('plantuml.class', { file: 'er-broken.puml' })).syntaxErrors, []);
  });

  it('отчёты JUnit из вложенных папок: счётчики, упавший, группа параметризованного теста; чужие файлы не мешают', async () => {
    write('reports/nested/pytest.xml', JUNIT_REPORT);
    write('reports/notes.txt', 'не отчёт');
    write('reports/broken.xml', '<testsuite><testcase');
    const facts = await probe<Facts>('junit.report', {});
    assert.equal(facts.exists, true);
    assert.deepEqual(facts.files, ['nested/pytest.xml']);
    assert.equal(facts.parseErrors.length, 1);
    assert.deepEqual([facts.tests, facts.passed, facts.failed, facts.skipped], [4, 3, 1, 0]);
    assert.equal(facts.maxGroupSize, 3);
    assert.ok(facts.failedNames.includes('test_daily_limit[c]'));
    assert.deepEqual((await probe<Facts>('junit.report', { dir: 'absent' })).exists, false);
  });
});
