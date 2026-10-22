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
