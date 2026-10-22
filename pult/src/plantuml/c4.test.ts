import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseC4 } from './c4';

const CONTAINERS = `@startuml
!include https://raw.githubusercontent.com/plantuml-stdlib/C4-PlantUML/master/C4_Container.puml
Person(client, "Клиент", "Подаёт документы на согласование")
System_Boundary(edo, "Документооборот") {
  Container(api, "API", "Node.js", "Принимает документы")
  ContainerQueue(broker, "Брокер", "RabbitMQ")
  ContainerDb(db, "База", "PostgreSQL", "Документы и решения")
}
System_Ext(mail, "Почта", "Отправляет уведомления")
Rel(client, api, "Отправляет документ", "HTTPS")
Rel_D(api, broker, "Публикует doc.created", "AMQP")
Rel_Back(db, api, "Читает и пишет", "SQL")
Rel(api, mail, "Уведомляет")
@enduml`;

describe('parseC4', () => {
  const diagram = parseC4(CONTAINERS);
  const find = (alias: string) => diagram.elements.find((element) => element.alias === alias);

  it('элементы с видом, подписью, технологией и описанием', () => {
    assert.deepEqual(find('client'), {
      kind: 'Person',
      alias: 'client',
      label: 'Клиент',
      technology: null,
      description: 'Подаёт документы на согласование',
      external: false,
      boundary: null,
    });
    assert.deepEqual(find('db'), {
      kind: 'ContainerDb',
      alias: 'db',
      label: 'База',
      technology: 'PostgreSQL',
      description: 'Документы и решения',
      external: false,
      boundary: 'Документооборот',
    });
    assert.equal(find('broker')?.kind, 'ContainerQueue');
    assert.equal(find('broker')?.description, null);
  });

  it('внешняя система помечена, граница не наследуется снаружи блока', () => {
    assert.equal(find('mail')?.external, true);
    assert.equal(find('mail')?.kind, 'System');
    assert.equal(find('mail')?.boundary, null);
    assert.equal(find('mail')?.technology, null);
  });

  it('связи с подписью и технологией, Rel_Back меняет концы', () => {
    assert.deepEqual(diagram.relations, [
      { from: 'client', to: 'api', label: 'Отправляет документ', technology: 'HTTPS' },
      { from: 'api', to: 'broker', label: 'Публикует doc.created', technology: 'AMQP' },
      { from: 'api', to: 'db', label: 'Читает и пишет', technology: 'SQL' },
      { from: 'api', to: 'mail', label: 'Уведомляет', technology: null },
    ]);
    assert.deepEqual(diagram.errors, []);
  });

  it('связь на несуществующий элемент и незакрытая граница — ошибки', () => {
    const broken = parseC4('System(a, "A")\nRel(a, ghost, "x")\nBoundary(b, "B") {');
    assert.deepEqual(broken.errors, ['связь ссылается на неизвестный элемент ghost', 'Boundary не закрыт']);
  });
});
