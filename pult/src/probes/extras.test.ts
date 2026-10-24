import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { duplicateKeys, operationFacts, pollFacts, pollSummaries } from './bank';
import { stateFacts } from './diagrams';
import { describeMessage, fieldPaths, summarizeByKey, userTopics } from './kafka';
import { EXECUTORS } from './registry';

let dir = '';

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'kit-extras-'));
  mkdirSync(join(dir, 'tests', 'unit'), { recursive: true });
  mkdirSync(join(dir, 'tests', 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(dir, 'empty'));
  writeFileSync(join(dir, 'tests', 'a.test.js'), 'x');
  writeFileSync(join(dir, 'tests', 'unit', 'b.test.js'), 'y');
  writeFileSync(join(dir, 'tests', '.hidden'), 'z');
  writeFileSync(join(dir, 'tests', 'node_modules', 'pkg', 'index.js'), 'w');
  writeFileSync(join(dir, 'single.txt'), 'file, not a directory');
  mkdirSync(join(dir, 'py', 'venv', 'lib'), { recursive: true });
  mkdirSync(join(dir, 'py', '__pycache__'), { recursive: true });
  writeFileSync(join(dir, 'py', 'test_transfer.py'), 'def test(): ...');
  writeFileSync(join(dir, 'py', 'venv', 'lib', 'site.py'), 'lib');
  writeFileSync(join(dir, 'py', '__pycache__', 'test.pyc'), 'cache');
  writeFileSync(join(dir, 'py', 'package-lock.json'), '{}');
});

after(() => rmSync(dir, { recursive: true, force: true }));

const ctx = () => ({ workDir: dir, label: 'k7f3qa' });
const exec = (key: string, params: Record<string, unknown>) => EXECUTORS[key]!(params, ctx());

describe('file.bundle', () => {
  it('собирает тексты файлов папки с путями, без скрытых и node_modules', async () => {
    assert.deepEqual(await exec('file.bundle', { dir: 'tests' }), {
      exists: true,
      files: [
        { path: 'a.test.js', text: 'x' },
        { path: 'unit/b.test.js', text: 'y' },
      ],
      omitted: 0,
    });
  });

  it('обрезает по общему пределу символов и считает пропущенные', async () => {
    assert.deepEqual(await exec('file.bundle', { dir: 'tests', maxChars: 1 }), {
      exists: true,
      files: [{ path: 'a.test.js', text: 'x' }],
      omitted: 1,
    });
  });

  it('окружение, кэш и lock-файлы не отправляет, считает их пропущенными', async () => {
    assert.deepEqual(await exec('file.bundle', { dir: 'py' }), {
      exists: true,
      files: [{ path: 'test_transfer.py', text: 'def test(): ...' }],
      omitted: 3,
    });
  });

  it('нет папки — exists false', async () => {
    assert.deepEqual(await exec('file.bundle', { dir: 'nope' }), { exists: false, files: [], omitted: 0 });
  });
});

describe('file.list', () => {
  it('считает файлы вместе с вложенными, пропускает скрытые и node_modules, пути относительные', async () => {
    assert.deepEqual(await exec('file.list', { dir: 'tests' }), {
      exists: true,
      count: 2,
      files: ['a.test.js', 'unit/b.test.js'],
    });
  });

  it('пустая папка, нет папки и файл вместо папки — ноль файлов', async () => {
    assert.deepEqual(await exec('file.list', { dir: 'empty' }), { exists: true, count: 0, files: [] });
    assert.deepEqual(await exec('file.list', { dir: 'nope' }), { exists: false, count: 0, files: [] });
    assert.deepEqual(await exec('file.list', { dir: 'single.txt' }), { exists: false, count: 0, files: [] });
  });

  it('выход за пределы work/ — ошибка пути', async () => {
    await assert.rejects(exec('file.list', { dir: '../etc' }), /выходит за пределы/);
  });
});

describe('kit.wait', () => {
  it('ждёт заданное число секунд', async () => {
    const started = Date.now();
    assert.deepEqual(await exec('kit.wait', { seconds: 1 }), { waited: 1 });
    assert.ok(Date.now() - started >= 950);
  });
});

describe('kafka.messages: разбор значения', () => {
  it('JSON становится объектом, исходный текст сохраняется, поля — пути включая вложенные', () => {
    const message = describeMessage({
      partition: 0,
      offset: 3,
      key: '10000002',
      value: '{"eventId":"e1","amount":150050,"client":{"number":"10000002"},"items":[{"sku":"a"}]}',
      headers: {},
    });
    assert.deepEqual(message.value, {
      eventId: 'e1',
      amount: 150050,
      client: { number: '10000002' },
      items: [{ sku: 'a' }],
    });
    assert.equal(message.raw, '{"eventId":"e1","amount":150050,"client":{"number":"10000002"},"items":[{"sku":"a"}]}');
    assert.deepEqual(message.fields, ['eventId', 'amount', 'client', 'client.number', 'items', 'items[].sku']);
  });

  it('не JSON остаётся строкой без полей', () => {
    const message = describeMessage({ key: 'k', value: 'просто текст', headers: {} });
    assert.equal(message.value, 'просто текст');
    assert.deepEqual(message.fields, []);
    assert.deepEqual(fieldPaths('текст'), []);
    assert.deepEqual(describeMessage({ key: 'k', value: '[1,2]', headers: {} }).fields, []);
  });
});

describe('plantuml.state: переходы без конечной точки', () => {
  it('переходы в [*] не входят в transitionsWithoutFinal, переходы из [*] входят', () => {
    const facts = stateFacts(`@startuml
title Статусы
[*] --> CREATED
CREATED --> CHECKING
CHECKING --> COMPLETED
COMPLETED --> [*]
@enduml`);
    assert.deepEqual(
      facts.transitionsWithoutFinal.map((item) => `${item.from} -> ${item.to}`),
      ['[*] -> CREATED', 'CREATED -> CHECKING', 'CHECKING -> COMPLETED'],
    );
    assert.deepEqual(facts.edges.at(-1), 'COMPLETED -> [*]');
  });
});

describe('факты банка', () => {
  it('ключи повтора, встретившиеся дважды и чаще, — с числом запросов и разных операций', () => {
    assert.deepEqual(
      duplicateKeys([
        { idempotencyKey: 'a-key-0001', operationId: 'op-1' },
        { idempotencyKey: 'b-key-0002' },
        { idempotencyKey: 'a-key-0001', operationId: 'op-1' },
        { idempotencyKey: 'a-key-0001', operationId: null },
        { idempotencyKey: null },
        {},
      ]),
      [{ key: 'a-key-0001', count: 3, operations: 1 }],
    );
    assert.deepEqual(duplicateKeys([{ idempotencyKey: 'x' }]), []);
  });

  it('ключ, по которому созданы две операции, виден по числу разных операций', () => {
    assert.deepEqual(
      duplicateKeys([
        { idempotencyKey: 'k-0000001', operationId: 'op-1' },
        { idempotencyKey: 'k-0000001', operationId: 'op-2' },
      ]),
      [{ key: 'k-0000001', count: 2, operations: 2 }],
    );
  });

  it('у операции есть возраст и признак копеек, даже если банк их не прислал', () => {
    assert.deepEqual(
      [operationFacts({ number: 'ZB1' }).ageSeconds, operationFacts({ number: 'ZB1' }).hasKopecks],
      [0, false],
    );
    const facts = operationFacts({ number: 'ZB1', ageSeconds: 45, hasKopecks: true });
    assert.equal(facts.ageSeconds, 45);
    assert.equal(facts.hasKopecks, true);
  });
});

describe('platform.answer', () => {
  it('ответ уходит в сдачу попытки одним полем answer', async () => {
    const saved: Array<Record<string, string>> = [];
    await EXECUTORS['platform.answer']!(
      { answer: '40817810000000000001' },
      { workDir: dir, label: 'k7f3qa', saveReport: async (report) => void saved.push(report) },
    );
    assert.deepEqual(saved, [{ answer: '40817810000000000001' }]);
  });

  it('ответ из нескольких полей уходит в сдачу целиком', async () => {
    const saved: Array<Record<string, string>> = [];
    await EXECUTORS['platform.answer']!(
      { documents: 'Статусная модель', available: '50000' },
      { workDir: dir, label: 'k7f3qa', saveReport: async (report) => void saved.push(report) },
    );
    assert.deepEqual(saved, [{ documents: 'Статусная модель', available: '50000' }]);
  });

  it('вне попытки — понятная ошибка', async () => {
    await assert.rejects(exec('platform.answer', { answer: '1' }), /внутри попытки/);
  });
});

describe('kafka.messages: сводка по ключам', () => {
  const event = (key: string, partition: number, offset: number, at: unknown) => ({
    key,
    partition,
    offset,
    value: { documentId: key, at },
  });

  it('по ключу — число сообщений, партиции и порядок по полю значения внутри партиции', () => {
    const summary = summarizeByKey(
      [
        event('doc-1', 2, 0, '2026-10-21T09:00:00Z'),
        event('doc-2', 0, 0, '2026-10-21T09:00:00Z'),
        event('doc-1', 2, 1, '2026-10-21T09:05:00Z'),
        event('doc-1', 2, 2, '2026-10-21T09:10:00Z'),
      ],
      'at',
    );
    assert.deepEqual(summary, [
      { key: 'doc-1', count: 3, partitions: [2], orderedBy: { field: 'at', ok: true } },
      { key: 'doc-2', count: 1, partitions: [0], orderedBy: { field: 'at', ok: true } },
    ]);
  });

  it('значение, идущее назад, и разные партиции у одного ключа видны отдельно', () => {
    const [shuffled] = summarizeByKey(
      [event('doc-1', 1, 0, '2026-10-21T09:10:00+03:00'), event('doc-1', 1, 1, '2026-10-21T09:05:00+03:00')],
      'at',
    );
    assert.equal(shuffled?.orderedBy.ok, false);
    const [spread] = summarizeByKey([event('doc-1', 0, 0, '2026-10-21T09:00:00Z'), event('doc-1', 1, 0, '2026-10-21T09:05:00Z')], 'at');
    assert.deepEqual(spread?.partitions, [0, 1]);
  });

  it('смещение часового пояса учитывается, а числа и текст сравниваются по своим правилам', () => {
    const [zone] = summarizeByKey(
      [event('a', 0, 0, '2026-10-21T10:00:00+03:00'), event('a', 0, 1, '2026-10-21T08:00:00Z')],
      'at',
    );
    assert.equal(zone?.orderedBy.ok, true);
    const [numbers] = summarizeByKey([event('n', 0, 0, 2), event('n', 0, 1, 10)], 'at');
    assert.equal(numbers?.orderedBy.ok, true);
  });

  it('нет поля, не JSON или смесь типов — порядок не подтверждён', () => {
    assert.equal(summarizeByKey([event('a', 0, 0, undefined)], 'at')[0]?.orderedBy.ok, false);
    assert.equal(summarizeByKey([{ key: 'a', partition: 0, offset: 0, value: 'текст' }], 'at')[0]?.orderedBy.ok, false);
    assert.equal(summarizeByKey([event('a', 0, 0, 1), event('a', 0, 1, 'позже')], 'at')[0]?.orderedBy.ok, false);
  });

  it('другое поле задаётся параметром, пустой список даёт пустую сводку', () => {
    const [custom] = summarizeByKey([{ key: 'a', partition: 0, offset: 0, value: { seq: 1 } }, { key: 'a', partition: 0, offset: 1, value: { seq: 2 } }], 'seq');
    assert.deepEqual(custom?.orderedBy, { field: 'seq', ok: true });
    assert.deepEqual(summarizeByKey([], 'at'), []);
  });
});

describe('список топиков брокера', () => {
  it('служебные топики брокера не попадают в список, остальные отсортированы без повторов', () => {
    assert.deepEqual(
      userTopics(['bank.payments.status-changed', '__consumer_offsets', '_schemas', 'bank.antifraud.decisions', 'bank.payments.created', 'bank.payments.created']),
      ['bank.antifraud.decisions', 'bank.payments.created', 'bank.payments.status-changed'],
    );
    assert.deepEqual(userTopics([]), []);
  });
});

describe('bank.requestLog: опрос операции', () => {
  const OP = '0b2f4a5e-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
  const get = (at: string, terminalAt: string | null, operationId: string | null = OP) => ({
    method: 'GET',
    path: operationId ? `/api/v1/operations/${operationId}` : '/api/v1/operations',
    operationId,
    at,
    operationTerminalAt: terminalAt,
  });
  const terminal = '2026-10-20T10:00:03+03:00';

  it('опросы считаются по операции: сколько всего, сколько после конечного статуса, первый и последний', () => {
    const requests = [
      { method: 'POST', path: '/api/v1/transfers', operationId: OP, at: '2026-10-20T10:00:00+03:00', operationTerminalAt: terminal },
      get('2026-10-20T10:00:01+03:00', terminal),
      get('2026-10-20T10:00:02+03:00', terminal),
      get('2026-10-20T10:00:04+03:00', terminal),
    ];
    assert.deepEqual(pollSummaries(requests), [
      {
        operationId: OP,
        polls: 3,
        pollsAfterTerminal: 1,
        firstPollAt: '2026-10-20T10:00:01+03:00',
        lastPollAt: '2026-10-20T10:00:04+03:00',
        terminalAt: terminal,
      },
    ]);
  });

  it('список операций и чужие методы опросом не считаются; пока операция в работе, после конечного статуса ноль', () => {
    const facts = pollFacts([get('2026-10-20T10:00:01+03:00', null, null), get('2026-10-20T10:00:02+03:00', null)]);
    assert.equal(facts.polls.length, 1);
    assert.equal(facts.maxPolls, 1);
    assert.equal(facts.maxPollsAfterTerminal, 0);
    assert.equal(facts.polledTerminalCount, 0);
  });

  it('без запросов — нули', () => {
    assert.deepEqual(pollFacts([]), { polls: [], maxPolls: 0, maxPollsAfterTerminal: 0, polledTerminalCount: 0 });
  });
});
