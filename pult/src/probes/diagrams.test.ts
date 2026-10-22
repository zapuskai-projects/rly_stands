import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { c4Facts, classFacts, encodePlantuml, extractTitle, sequenceFacts, stateFacts } from './diagrams';

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

  it('диаграмма состояний: заголовок, состояния, переходы и список рёбер', () => {
    const facts = stateFacts('@startuml\ntitle k3x9ab Статусы\n[*] --> CREATED\nCREATED --> CHECKING : принят\nCHECKING --> [*]\n@enduml');
    assert.equal(facts.title, 'k3x9ab Статусы');
    assert.deepEqual(facts.states.map((state) => state.name), ['CREATED', 'CHECKING']);
    assert.deepEqual(facts.edges, ['[*] -> CREATED', 'CREATED -> CHECKING', 'CHECKING -> [*]']);
    assert.equal(facts.transitions[1]?.label, 'принят');
    assert.deepEqual(facts.syntaxErrors, []);
  });
});
