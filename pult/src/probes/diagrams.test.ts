import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { c4Facts, classFacts, encodePlantuml, extractTitle, linkPairs, sequenceFacts, stateFacts } from './diagrams';

const SEQUENCE = `@startuml
title k3x9ab Согласование документа
actor Клиент
participant API
queue Брокер
Клиент -> API: POST /documents
API ->> Брокер: doc.created
@enduml`;

describe('extractTitle', () => {
  it('однострочный и блочный заголовок', () => {
    assert.equal(extractTitle(SEQUENCE), 'k3x9ab Согласование документа');
    assert.equal(extractTitle('@startuml\ntitle\nПервая\nвторая\nend title\n@enduml'), 'Первая вторая');
    assert.equal(extractTitle('@startuml\nA -> B\n@enduml'), '');
  });
});

describe('encodePlantuml', () => {
  it('совпадает с кодированием PlantUML-сервера', () => {
    assert.equal(encodePlantuml('@startuml\nA -> B: hi\n@enduml'), 'SoWkIImgAStDuN9KqBLJSB9IoCZaSaZDIodDpG40');
  });
});

describe('факты диаграмм', () => {
  it('диаграмма последовательности: заголовок, участники и сообщения по порядку', () => {
    const facts = sequenceFacts(SEQUENCE);
    assert.equal(facts.title, 'k3x9ab Согласование документа');
    assert.deepEqual(facts.participants.map((item) => item.name), ['Клиент', 'API', 'Брокер']);
    assert.deepEqual(facts.messages.map((item) => `${item.from}>${item.to}:${item.label}`), [
      'Клиент>API:POST /documents',
      'API>Брокер:doc.created',
    ]);
    assert.deepEqual(facts.syntaxErrors, []);
  });

  it('перепутанный порядок и лишний участник видны в фактах', () => {
    const swapped = sequenceFacts(SEQUENCE.replace('Клиент -> API: POST /documents\nAPI ->> Брокер: doc.created', 'API ->> Брокер: doc.created\nКлиент -> API: POST /documents'));
    assert.equal(swapped.messages[0]?.label, 'doc.created');
    const extra = sequenceFacts(`${SEQUENCE.replace('@enduml', '')}participant Лишний\n@enduml`);
    assert.equal(extra.participants.length, 4);
  });

  it('классы и C4 несут заголовок и свои элементы', () => {
    const classes = classFacts('@startuml\ntitle k3x9ab Модель\nclass Document {\n  +id: UUID\n}\nDocument \"1\" *-- \"0..*\" Approval\n@enduml');
    assert.equal(classes.title, 'k3x9ab Модель');
    assert.ok(classes.classes.some((item) => item.name === 'Document'));
    assert.equal(classes.relations[0]?.kind, 'composition');
    const c4 = c4Facts('@startuml\n!include <C4/C4_Container>\ntitle k3x9ab Контейнеры\nPerson(client, \"Клиент\")\nContainer(api, \"API\", \"Node.js\")\nRel(client, api, \"Отправляет\", \"HTTPS\")\n@enduml');
    assert.equal(c4.title, 'k3x9ab Контейнеры');
    assert.deepEqual(c4.elements.map((item) => item.alias), ['client', 'api']);
    assert.equal(c4.relations[0]?.technology, 'HTTPS');
  });

  it('C4: подписи и техника всех связей одним текстом для поиска топиков и очередей', () => {
    const source = [
      '@startuml',
      '!include <C4/C4_Container>',
      'title k3x9ab Банк',
      'Person(client, "Клиент")',
      'Container(core, "Ядро", "Node.js")',
      'ContainerQueue(kafka, "Kafka", "Kafka")',
      'ContainerQueue(rabbit, "RabbitMQ", "AMQP")',
      'ContainerDb(ch, "ClickHouse", "ClickHouse")',
      'System_Ext(sbp, "СБП", "Эмулятор")',
      'Rel_R(core, kafka, "Публикует bank.payments.created", "Kafka")',
      'Rel_D(core, rabbit, "Кладёт в очередь bank.notifications", "AMQP")',
      'Rel_L(ch, kafka, "Читает bank.payments.status-changed", "Kafka")',
      'Rel(core, sbp, "Запрашивает перевод")',
      '@enduml',
    ].join('\n');
    const facts = c4Facts(source);
    assert.deepEqual(facts.syntaxErrors, []);
    assert.deepEqual(facts.elements.map((item) => item.kind), ['Person', 'Container', 'ContainerQueue', 'ContainerQueue', 'ContainerDb', 'System']);
    assert.equal(facts.elements.at(-1)?.external, true);
    for (const text of ['bank.payments.created', 'bank.notifications', 'bank.payments.status-changed', 'AMQP']) {
      assert.ok(facts.relationsText.includes(text), text);
    }
    assert.equal(facts.relationsText.includes('bank.antifraud.decisions'), false);
  });

  it('диаграмма состояний: заголовок, состояния, переходы и список рёбер', () => {
    const facts = stateFacts('@startuml\ntitle k3x9ab Статусы\n[*] --> CREATED\nCREATED --> CHECKING : принят\nCHECKING --> [*]\n@enduml');
    assert.equal(facts.title, 'k3x9ab Статусы');
    assert.deepEqual(facts.states.map((state) => state.name), ['CREATED', 'CHECKING']);
    assert.deepEqual(facts.edges, ['[*] -> CREATED', 'CREATED -> CHECKING', 'CHECKING -> [*]']);
    assert.equal(facts.transitions[1]?.label, 'принят');
    assert.deepEqual(facts.syntaxErrors, []);
  });
});

describe('linkPairs', () => {
  it('пары сущностей без учёта направления и повторов', () => {
    assert.deepEqual(
      linkPairs([
        { from: 'accounts', to: 'clients' },
        { from: 'clients', to: 'accounts' },
        { from: 'postings', to: 'operations' },
      ]),
      ['accounts--clients', 'operations--postings'],
    );
  });

  it('факты ER-файла несут пары для проверки связей', () => {
    const facts = classFacts('@startuml\nentity a {\n}\nentity b {\n}\nb }o--|| a\n@enduml');
    assert.deepEqual(facts.linkPairs, ['a--b']);
  });
});
