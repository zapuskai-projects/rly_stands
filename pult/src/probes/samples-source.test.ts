import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseDocumentText } from './document';
import { checkJsonSchemaSamples, describeJsonSchema } from './jsonschema';
import { describeOpenApi } from './openapi';
import { ProbeError } from './errors';
import { EXECUTORS } from './registry';
import { collectObservations } from './run';
import { pickPath, requiredMissing, samplesFromObservation } from './samples-source';

const kafka = {
  count: 3,
  messages: [
    { key: 'op-1', value: { eventId: 'e1', operationNumber: 'ZB1', amount: 15000 } },
    { key: 'op-2', value: { eventId: 'e2', operationNumber: 'ZB2', amount: 2500 } },
    { key: 'op-3', value: { eventId: 'e3', operationNumber: 'ZB3', amount: 99, note: 'x' } },
  ],
};

describe('образцы из результата другой проверки', () => {
  it('путь с [] берёт поле у каждого элемента списка', () => {
    assert.deepEqual(pickPath(kafka, 'messages[].value.eventId'), ['e1', 'e2', 'e3']);
    assert.deepEqual(pickPath(kafka, 'messages[].key'), ['op-1', 'op-2', 'op-3']);
    assert.equal(pickPath(kafka, 'count'), 3);
    assert.equal((pickPath(kafka, 'messages[]') as unknown[]).length, 3);
    assert.deepEqual(pickPath({}, 'messages[].value'), []);
  });

  it('каждый образец ждёт, что схема его примет', () => {
    const samples = samplesFromObservation({ events: kafka }, { probe: 'events', path: 'messages[].value' });
    assert.equal(samples.length, 3);
    assert.ok(samples.every((sample) => sample.expectValid));
    assert.deepEqual(samples[0]?.data, kafka.messages[0]?.value);
  });

  it('нет результата проверки-источника, она упала или по пути не список — проверка не состоялась', () => {
    assert.throws(() => samplesFromObservation({}, { probe: 'events', path: 'messages[]' }), ProbeError);
    assert.throws(() => samplesFromObservation(undefined, { probe: 'events', path: 'messages[]' }), /раньше/);
    assert.throws(() => samplesFromObservation({ events: { error: 'Kafka не отвечает' } }, { probe: 'events', path: 'messages[]' }), /Kafka не отвечает/);
    assert.throws(() => samplesFromObservation({ events: kafka }, { probe: 'events', path: 'count' }), /нет списка образцов/);
  });

  it('поля, которые есть во всех образцах, но не названы в required', () => {
    const samples = samplesFromObservation({ events: kafka }, { probe: 'events', path: 'messages[].value' });
    assert.deepEqual(requiredMissing(samples, ['eventId']), ['amount', 'operationNumber']);
    assert.deepEqual(requiredMissing(samples, ['eventId', 'amount', 'operationNumber']), []);
    assert.deepEqual(requiredMissing(samples, undefined), ['amount', 'eventId', 'operationNumber']);
    assert.deepEqual(requiredMissing([], []), []);
  });

  it('образцы против схемы студента: прошли все, отсутствие поля в required видно', () => {
    const schema = parseDocumentText(
      JSON.stringify({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        required: ['eventId'],
        properties: { eventId: { type: 'string' }, operationNumber: { type: 'string' }, amount: { type: 'integer' }, note: { type: 'string' } },
        additionalProperties: false,
      }),
    );
    const samples = samplesFromObservation({ events: kafka }, { probe: 'events', path: 'messages[].value' });
    const result = checkJsonSchemaSamples(schema, samples);
    assert.equal(result.allOk, true);
    assert.equal(result.sampleCount, 3);
    assert.deepEqual(result.requiredMissing, ['amount', 'operationNumber']);
  });

  it('схема с number вместо integer не принимает суммы-дроби, а ошибка видна по каждому образцу', () => {
    const schema = parseDocumentText(
      JSON.stringify({ type: 'object', properties: { amount: { type: 'string' } }, required: ['amount'] }),
    );
    const result = checkJsonSchemaSamples(schema, samplesFromObservation({ events: kafka }, { probe: 'events', path: 'messages[].value' }));
    assert.equal(result.allOk, false);
    assert.equal(result.results.length, 3);
    assert.ok(result.results.every((item) => item.errors.length > 0));
  });

  it('нет образцов — не зачёт', () => {
    const schema = parseDocumentText('{"type":"object"}');
    assert.equal(checkJsonSchemaSamples(schema, []).allOk, false);
  });

  it('в списке проверок образцы берутся из результата проверки, стоящей выше', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-samples-'));
    writeFileSync(join(dir, 'event.schema.json'), JSON.stringify({ type: 'object', required: ['eventId'], properties: { eventId: { type: 'string' } } }));
    EXECUTORS['test.events'] = async () => kafka;
    try {
      const observations = await collectObservations(
        [
          { id: 'events', probe: 'test.events', params: {} },
          { id: 'schema', probe: 'jsonschema.samples', params: { file: 'event.schema.json', samplesFrom: { probe: 'events', path: 'messages[].value' } } },
          { id: 'early', probe: 'jsonschema.samples', params: { file: 'event.schema.json', samplesFrom: { probe: 'later', path: 'messages[].value' } } },
          { id: 'later', probe: 'test.events', params: {} },
        ],
        { workDir: dir, label: 'k3x9ab' },
      );
      const schema = observations.schema as { allOk: boolean; sampleCount: number; requiredMissing: string[] };
      assert.equal(schema.allOk, true);
      assert.equal(schema.sampleCount, 3);
      assert.deepEqual(schema.requiredMissing, ['amount', 'operationNumber']);
      assert.match(String((observations.early as { error: string }).error), /раньше/);
    } finally {
      delete EXECUTORS['test.events'];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('неразрешимая ссылка в OpenAPI даёт parsed=false и диагностику', () => {
  const result = describeOpenApi(parseDocumentText(JSON.stringify({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {}, components: { schemas: { X: { properties: { id: { $ref: '#/components/schemas/Missing' } } } } } })));
  assert.equal(result.parsed, false);
  assert.match(result.errors[0] ?? '', /ссылка/);
});

describe('ссылки и обязательные поля схемы', () => {
  it('булева ветвь allOf не выглядит циклом', () => {
    const valid = parseDocumentText(JSON.stringify({
      type: 'object', properties: { id: { type: 'string' } }, allOf: [true, { required: ['id'] }],
    }));
    assert.equal(describeJsonSchema(valid).parsed, true);
    assert.deepEqual(describeJsonSchema(valid).required, ['id']);
    assert.equal(checkJsonSchemaSamples(valid, [{ data: { id: 'x' }, expectValid: true }]).allOk, true);
    const impossible = parseDocumentText(JSON.stringify({ type: 'object', allOf: [false] }));
    assert.equal(describeJsonSchema(impossible).parsed, true);
    assert.equal(checkJsonSchemaSamples(impossible, [{ data: {}, expectValid: true }]).allOk, false);
  });

  it('required рядом с корневой ссылкой и ссылкой внутри allOf учитывается', () => {
    const base = { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { Base: { type: 'object', properties: { id: { type: 'string' } } } } };
    for (const schema of [
      { ...base, $ref: '#/$defs/Base', required: ['id'] },
      { ...base, allOf: [{ $ref: '#/$defs/Base', required: ['id'] }] },
    ]) {
      const loaded = parseDocumentText(JSON.stringify(schema));
      assert.deepEqual(describeJsonSchema(loaded).required, ['id']);
      assert.deepEqual(checkJsonSchemaSamples(loaded, [{ data: { id: 'x' }, expectValid: true }]).requiredMissing, []);
      assert.equal(checkJsonSchemaSamples(loaded, [{ data: {}, expectValid: true }]).allOk, false);
    }
    const absent = parseDocumentText(JSON.stringify({ ...base, $ref: '#/$defs/Base' }));
    assert.deepEqual(checkJsonSchemaSamples(absent, [{ data: { id: 'x' }, expectValid: true }]).requiredMissing, ['id']);
  });

  it('required промежуточной ссылки в цепочке не теряется', () => {
    const schema = parseDocumentText(JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema', $ref: '#/$defs/A',
      $defs: { A: { $ref: '#/$defs/B', required: ['id'] }, B: { type: 'object', properties: { id: { type: 'string' } } } },
    }));
    assert.deepEqual(describeJsonSchema(schema).required, ['id']);
    assert.deepEqual(checkJsonSchemaSamples(schema, [{ data: { id: 'x' }, expectValid: true }]).requiredMissing, []);
    assert.equal(checkJsonSchemaSamples(schema, [{ data: {}, expectValid: true }]).allOk, false);
  });

  it('цикл ссылок A-B-A диагностируется', () => {
    const schema = parseDocumentText(JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema', $ref: '#/$defs/A',
      $defs: { A: { $ref: '#/$defs/B' }, B: { $ref: '#/$defs/A' } },
    }));
    assert.equal(describeJsonSchema(schema).parsed, false);
    assert.equal(checkJsonSchemaSamples(schema, [{ data: {}, expectValid: false }]).allOk, false);
  });

  it('OpenAPI 3.0 не применяет required рядом с Reference Object', () => {
    const loaded = parseDocumentText(JSON.stringify({
      openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {},
      components: { schemas: { Base: { type: 'object', properties: { id: { type: 'string' } } }, Alias: { $ref: '#/components/schemas/Base', required: ['id'] } } },
    }));
    const facts = describeOpenApi(loaded);
    assert.equal(facts.parsed, true);
    assert.deepEqual((facts.schemas as { name: string; fields: { required: boolean }[] }[]).find((x) => x.name === 'Alias')?.fields.map((x) => x.required), [false]);
  });

  it('локальная ссылка сохраняет примитивный тип и ограничения, объектная ссылка сохраняет имя', () => {
    const facts = describeJsonSchema(parseDocumentText(JSON.stringify({
      type: 'object',
      properties: { amount: { $ref: '#/$defs/Money' }, bad: { $ref: '#/$defs/Text' }, details: { $ref: '#/$defs/Details' } },
      $defs: { Money: { type: 'integer', minimum: 1 }, Text: { type: 'string' }, Details: { type: 'object', properties: { id: { type: 'string' } } } },
    })));
    assert.deepEqual(facts.properties.map((field) => [field.name, field.type, field.minimum]), [
      ['amount', 'integer', 1], ['bad', 'string', null], ['details', 'Details', null], ['details.id', 'string', null],
    ]);
  });

  it('именованная объектная ссылка раскрывает вложенный код причины', () => {
    const loaded = parseDocumentText(JSON.stringify({
      openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {},
      components: { schemas: {
        Operation: { type: 'object', properties: { rejection: { $ref: '#/components/schemas/Rejection' } } },
        Rejection: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } },
      } },
    }));
    const facts = describeOpenApi(loaded);
    const operation = (facts.schemas as { name: string; fields: { name: string; type: string; required: boolean }[] }[]).find((item) => item.name === 'Operation');
    assert.deepEqual(operation?.fields.map((field) => [field.name, field.type, field.required]), [
      ['rejection', 'Rejection', false], ['rejection.code', 'string', true],
    ]);
    const broken = parseDocumentText(JSON.stringify({
      openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {},
      components: { schemas: {
        Operation: { type: 'object', properties: { rejection: { $ref: '#/components/schemas/Rejection' } } },
        Rejection: { type: 'object', properties: {} },
      } },
    }));
    const brokenFacts = describeOpenApi(broken);
    const brokenOperation = (brokenFacts.schemas as { name: string; fields: { name: string }[] }[]).find((item) => item.name === 'Operation');
    assert.equal(brokenOperation?.fields.some((field) => field.name === 'rejection.code'), false);
  });

  it('required из вложенного allOf и ссылки используется в описании и проверке образцов', () => {
    const schema = parseDocumentText(JSON.stringify({
      type: 'object', properties: { id: { type: 'string' }, amount: { type: 'integer' }, optional: { type: 'string' } },
      allOf: [{ $ref: '#/$defs/Required' }],
      anyOf: [{ required: ['optional'] }, { required: ['id'] }],
      $defs: { Required: { allOf: [{ required: ['id'] }, { required: ['amount'] }] } },
    }));
    assert.deepEqual(describeJsonSchema(schema).required, ['id', 'amount']);
    assert.deepEqual(checkJsonSchemaSamples(schema, [{ data: { id: 'x', amount: 2, optional: 'x' }, expectValid: true }]).requiredMissing, ['optional']);
  });

  it('отсутствующий required и нарушенный minimum остаются ошибками', () => {
    const base = { type: 'object', properties: { amount: { $ref: '#/$defs/Money' } }, $defs: { Money: { type: 'integer', minimum: 100 } } };
    const missing = parseDocumentText(JSON.stringify(base));
    assert.deepEqual(checkJsonSchemaSamples(missing, [{ data: { amount: 150 }, expectValid: true }]).requiredMissing, ['amount']);
    const required = parseDocumentText(JSON.stringify({ ...base, required: ['amount'] }));
    assert.equal(checkJsonSchemaSamples(required, [{ data: { amount: 99 }, expectValid: true }]).allOk, false);
    assert.equal(checkJsonSchemaSamples(required, [{ data: { amount: 150 }, expectValid: true }]).allOk, true);
  });

  it('циклическая и отсутствующая ссылки дают диагностику без зачёта', () => {
    for (const ref of ['#/$defs/Missing', '#/$defs/Cycle']) {
      const schema = parseDocumentText(JSON.stringify({ type: 'object', allOf: [{ $ref: ref }], $defs: { Cycle: { $ref: '#/$defs/Cycle' } } }));
      assert.equal(describeJsonSchema(schema).parsed, false);
      assert.equal(checkJsonSchemaSamples(schema, [{ data: {}, expectValid: false }]).allOk, false);
    }
  });
});
