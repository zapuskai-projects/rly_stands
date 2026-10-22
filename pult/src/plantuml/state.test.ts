import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseState } from './state';

const STATUSES = `@startuml
title Статусная модель платежа
hide empty description
[*] --> CREATED
state "Проверка" as CHECKING
state ON_REVIEW : ручная проверка
CREATED -down-> CHECKING : принят
CHECKING --> ON_REVIEW : оценка выше порога
CHECKING --> PROCESSING : оценка в норме
ON_REVIEW --> PROCESSING : оператор одобрил
ON_REVIEW -[#red]-> REJECTED : оператор отклонил
PROCESSING --> COMPLETED
COMPLETED --> [*]
REFUNDED <-- PROCESSING : тайм-аут СБП
@enduml`;

describe('parseState', () => {
  const diagram = parseState(STATUSES);
  const find = (name: string) => diagram.states.find((state) => state.name === name);

  it('состояния из объявлений и переходов, алиас и описание сохраняются', () => {
    assert.deepEqual(
      diagram.states.map((state) => state.name),
      ['CREATED', 'Проверка', 'ON_REVIEW', 'PROCESSING', 'REJECTED', 'COMPLETED', 'REFUNDED'],
    );
    assert.equal(find('Проверка')?.alias, 'CHECKING');
    assert.equal(find('ON_REVIEW')?.description, 'ручная проверка');
  });

  it('переходы идут по порядку: откуда, куда, подпись; начало и конец — [*]', () => {
    assert.deepEqual(diagram.transitions[0], { from: '[*]', to: 'CREATED', label: null, scope: null });
    assert.deepEqual(diagram.transitions[1], { from: 'CREATED', to: 'Проверка', label: 'принят', scope: null });
    assert.deepEqual(diagram.transitions.at(-2), { from: 'COMPLETED', to: '[*]', label: null, scope: null });
  });

  it('направленные и цветные стрелки читаются, обратная стрелка меняет концы', () => {
    const rejected = diagram.transitions.find((item) => item.to === 'REJECTED');
    assert.equal(rejected?.from, 'ON_REVIEW');
    assert.equal(rejected?.label, 'оператор отклонил');
    assert.deepEqual(diagram.transitions.at(-1), { from: 'PROCESSING', to: 'REFUNDED', label: 'тайм-аут СБП', scope: null });
  });

  it('перепутанная ветка видна: из PROCESSING нельзя в REJECTED, если такого перехода нет', () => {
    const edges = diagram.transitions.map((item) => `${item.from} -> ${item.to}`);
    assert.equal(edges.includes('PROCESSING -> REJECTED'), false);
    assert.equal(edges.includes('ON_REVIEW -> REJECTED'), true);
  });

  it('составное состояние запоминает вложенные переходы и закрывается', () => {
    const nested = parseState(`@startuml
state Проверка {
  [*] --> Антифрод
  Антифрод --> Оператор : выше порога
}
[*] --> Проверка
@enduml`);
    assert.deepEqual(nested.errors, []);
    assert.equal(nested.states.find((state) => state.name === 'Антифрод')?.parent, 'Проверка');
    assert.equal(nested.transitions[1]?.scope, 'Проверка');
    assert.equal(nested.transitions[2]?.scope, null);
  });

  it('незакрытый блок и лишняя скобка попадают в ошибки', () => {
    assert.deepEqual(parseState('state A {\n  [*] --> B\n').errors, ['блок состояния A не закрыт']);
    assert.deepEqual(parseState('}\nA --> B').errors, ['закрывающая скобка без состояния']);
  });

  it('пустой источник — пустая диаграмма без ошибок', () => {
    assert.deepEqual(parseState('@startuml\n@enduml'), { states: [], transitions: [], errors: [] });
  });
});
