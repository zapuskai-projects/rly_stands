import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseClasses } from './classes';

const MODEL = `@startuml
abstract class Document {
  +id: UUID
  -number: String
  +title : String
  +approve()
}
class Contract
class Approval {
  decision: Decision
  decidedAt: DateTime
}
enum Decision {
  APPROVED
  REJECTED
}
interface Notifier {
  +notify(user: User)
}
Document <|-- Contract
Document "1" *-- "0..*" Approval : решения
Approval --> Decision
Contract ..|> Notifier
@enduml`;

describe('parseClasses', () => {
  const diagram = parseClasses(MODEL);
  const find = (name: string) => diagram.classes.find((item) => item.name === name);

  it('классы с видом, атрибутами, типами и видимостью', () => {
    const document = find('Document');
    assert.equal(document?.kind, 'abstract');
    assert.deepEqual(document?.attributes, [
      { name: 'id', type: 'UUID', visibility: '+' },
      { name: 'number', type: 'String', visibility: '-' },
      { name: 'title', type: 'String', visibility: '+' },
    ]);
    assert.deepEqual(document?.methods, ['approve()']);
    assert.equal(find('Notifier')?.kind, 'interface');
  });

  it('перечисление хранит значения', () => {
    assert.deepEqual(find('Decision')?.values, ['APPROVED', 'REJECTED']);
    assert.equal(find('Decision')?.kind, 'enum');
  });

  it('связи с типом, направлением и кратностью', () => {
    assert.deepEqual(diagram.relations, [
      {
        from: 'Contract',
        to: 'Document',
        kind: 'inheritance',
        directed: true,
        fromMultiplicity: null,
        toMultiplicity: null,
        label: null,
      },
      {
        from: 'Document',
        to: 'Approval',
        kind: 'composition',
        directed: true,
        fromMultiplicity: '1',
        toMultiplicity: '0..*',
        label: 'решения',
      },
      {
        from: 'Approval',
        to: 'Decision',
        kind: 'association',
        directed: true,
        fromMultiplicity: null,
        toMultiplicity: null,
        label: null,
      },
      {
        from: 'Contract',
        to: 'Notifier',
        kind: 'realization',
        directed: true,
        fromMultiplicity: null,
        toMultiplicity: null,
        label: null,
      },
    ]);
  });

  it('кратность при обратной стрелке переходит вместе с концами', () => {
    const reversed = parseClasses('Part "0..*" --* "1" Whole');
    assert.deepEqual(reversed.relations[0], {
      from: 'Whole',
      to: 'Part',
      kind: 'composition',
      directed: true,
      fromMultiplicity: '1',
      toMultiplicity: '0..*',
      label: null,
    });
  });

  it('extends и implements в объявлении дают связи', () => {
    const diagram = parseClasses('class Contract extends Document implements Notifier');
    assert.deepEqual(
      diagram.relations.map((relation) => [relation.from, relation.to, relation.kind]),
      [
        ['Contract', 'Document', 'inheritance'],
        ['Contract', 'Notifier', 'realization'],
      ],
    );
  });

  it('атрибут одной строкой и незакрытый класс', () => {
    const inline = parseClasses('class User\nUser : email: String');
    assert.deepEqual(inline.classes[0]?.attributes, [{ name: 'email', type: 'String', visibility: null }]);
    assert.deepEqual(parseClasses('class A {\n  x: Int').errors, ['класс A не закрыт']);
  });
});

describe('ER-диаграмма: entity, ключи и связи с кратностью', () => {
  const ER = [
    '@startuml',
    'entity "clients" as clients {',
    '  * id : uuid <<PK>>',
    '  --',
    '  full_name : text',
    '}',
    'entity accounts {',
    '  * id : uuid <<PK>>',
    '  * client_id : uuid <<FK>>',
    '  balance_kop : numeric(19,2)',
    '}',
    'entity postings {',
    '  *id',
    '  --',
    '  * debit_account_id : uuid',
    '  operation_id <<FK>>',
    '}',
    'accounts }o--|| clients : владелец',
    'postings }|..|| accounts',
    'clients ||--o{ accounts',
    '@enduml',
  ].join('\n');

  it('entity разбирается как сущность, поля с типом, скобки в типе не делают поле методом', () => {
    const model = parseClasses(ER);
    assert.deepEqual(model.errors, []);
    assert.deepEqual(model.classes.map((item) => [item.name, item.kind]), [
      ['clients', 'entity'],
      ['accounts', 'entity'],
      ['postings', 'entity'],
    ]);
    const balance = model.classes[1]?.attributes.find((item) => item.name === 'balance_kop');
    assert.equal(balance?.type, 'numeric(19,2)');
    assert.deepEqual(model.classes[1]?.methods, []);
  });

  it('отметки ключа: <<PK>>, <<FK>>, звёздочка — обязательное, поля над разделителем без явного PK — ключ', () => {
    const [clients, accounts, postings] = parseClasses(ER).classes;
    assert.deepEqual(clients?.attributes.map((item) => [item.name, item.pk, item.fk, item.mandatory]), [
      ['id', true, false, true],
      ['full_name', false, false, false],
    ]);
    assert.deepEqual(accounts?.attributes.filter((item) => item.fk).map((item) => item.name), ['client_id']);
    assert.deepEqual(postings?.attributes.map((item) => [item.name, item.pk, item.fk]), [
      ['id', true, false],
      ['debit_account_id', false, false],
      ['operation_id', false, true],
    ]);
  });

  it('связи с кратностью вороньей лапки читаются в обе стороны', () => {
    const { relations } = parseClasses(ER);
    assert.deepEqual(
      relations.map((item) => [item.from, item.to, item.fromMultiplicity, item.toMultiplicity, item.label]),
      [
        ['accounts', 'clients', '0..*', '1', 'владелец'],
        ['postings', 'accounts', '1..*', '1', null],
        ['clients', 'accounts', '1', '0..*', null],
      ],
    );
  });

  it('выделение имени поля не меняет имя ключа и обязательность', () => {
    for (const prefix of ['', '- ', '* ']) {
      const diagram = parseClasses(`entity clients {\n${prefix}**id** : uuid <<PK>>\n${prefix}**tariff_code** : text <<FK>>\n}`);
      assert.deepEqual(diagram.errors, []);
      assert.deepEqual(diagram.classes[0]?.attributes, [
        { name: 'id', type: 'uuid', visibility: prefix === '- ' ? '-' : null, pk: true, fk: false, mandatory: prefix === '* ' },
        { name: 'tariff_code', type: 'text', visibility: prefix === '- ' ? '-' : null, pk: false, fk: true, mandatory: prefix === '* ' },
      ]);
    }
  });
});
