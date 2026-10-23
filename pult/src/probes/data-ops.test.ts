import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { operationTotals } from './bank';
import { c4Facts } from './diagrams';
import { repeatedEventIds } from './kafka';
import { queriesOfFile, rulesToDelete } from './monitoring';

describe('kafka.messages: повторы событий', () => {
  it('идентификаторы событий, пришедшие больше раза', () => {
    const messages = [
      { value: { eventId: 'a', amount: 1 } },
      { value: { eventId: 'b' } },
      { value: { eventId: 'a' } },
      { value: 'не JSON' },
      { value: { amount: 3 } },
    ];
    assert.deepEqual(repeatedEventIds(messages), ['a']);
    assert.deepEqual(repeatedEventIds([{ value: { eventId: 'x' } }]), []);
  });
});

describe('plantuml.c4: текст элементов', () => {
  it('подписи и технологии всех элементов одним текстом', () => {
    const facts = c4Facts(`@startuml
!include <C4/C4_Container>
Person(client, "Клиент")
Container(core, "Ядро", "Node.js")
ContainerQueue(kafka, "Kafka", "Redpanda")
ContainerDb(showcase, "Витрина", "ClickHouse")
Rel(core, kafka, "Публикует", "Kafka")
@enduml`);
    assert.match(facts.elementsText, /Клиент/);
    assert.match(facts.elementsText, /Витрина ClickHouse/);
    assert.match(facts.elementsText, /Kafka Redpanda/);
  });
});

describe('prometheus.queryFile: несколько запросов в файле', () => {
  const answers: Record<string, { series: number; value: number | null; queryError: string | null }> = {
    'a / b': { series: 1, value: 0.9, queryError: null },
    'histogram_quantile(0.95, x)': { series: 1, value: 2.5, queryError: null },
    'a / b\nhistogram_quantile(0.95, x)': { series: 0, value: null, queryError: 'parse error' },
  };
  const run = async (promql: string) => answers[promql] ?? { series: 0, value: null, queryError: 'нет такого запроса' };

  it('два запроса по строкам, верхний уровень — первый запрос', async () => {
    const facts = await queriesOfFile('a / b\nhistogram_quantile(0.95, x)\n', run);
    assert.equal(facts.queries.length, 2);
    assert.equal(facts.queries[1]?.query, 'histogram_quantile(0.95, x)');
    assert.equal(facts.queries[1]?.value, 2.5);
    assert.equal(facts.value, 0.9);
  });

  it('один запрос на всё содержимое остаётся одним запросом', async () => {
    const facts = await queriesOfFile('a / b', run);
    assert.equal(facts.queries.length, 1);
    assert.equal(facts.value, 0.9);
  });

  it('ошибка единственного запроса остаётся ошибкой', async () => {
    const facts = await queriesOfFile('bad', run);
    assert.equal(facts.queries.length, 1);
    assert.equal(facts.queryError, 'нет такого запроса');
  });
});

describe('prometheus.queryFile: предел числа запросов', () => {
  it('больше 20 строк — ошибка без обращения к Prometheus', async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
      return { series: 1, value: 1, queryError: null };
    };
    const text = Array.from({ length: 21 }, (_, index) => `up{n="${index}"}`).join('\n');
    const facts = await queriesOfFile(text, run);
    assert.match(facts.queryError ?? '', /слишком много запросов/);
    assert.equal(facts.queries.length, 0);
    assert.equal(calls, 0);
    assert.equal((await queriesOfFile(text.split('\n').slice(0, 20).join('\n'), run)).queryError, null);
  });
});

describe('grafana.deleteAlertRules: что можно удалить', () => {
  const rules = [
    { uid: 'a', title: 'SLA переводов: доля успешных', folderUID: 'kit' },
    { uid: 'b', title: 'SLA переводов: чужая папка', folderUID: 'other' },
    { uid: 'c', title: 'Другое правило', folderUID: 'kit' },
  ];

  it('только правила учебной папки с названием, содержащим фразу', () => {
    assert.deepEqual(rulesToDelete(rules, 'kit', 'SLA переводов').map((rule) => rule.uid), ['a']);
  });

  it('учебной папки нет — удалять нечего', () => {
    assert.deepEqual(rulesToDelete(rules, null, 'SLA переводов'), []);
  });
});

describe('bank.operations: итоги по операциям', () => {
  it('сумма в копейках и число смен статуса без создания', () => {
    const operations = [
      { amountKop: 100000, statusHistory: [{ status: 'CREATED' }, { status: 'CHECKING' }, { status: 'COMPLETED' }] },
      { amountKop: 250050, statusHistory: [{ status: 'CREATED' }, { status: 'CHECKING' }] },
      { amountKop: 1, statusHistory: [] },
    ];
    assert.deepEqual(operationTotals(operations), { totalKop: 350051, transitionsCount: 3 });
    assert.deepEqual(operationTotals([]), { totalKop: 0, transitionsCount: 0 });
  });
});
