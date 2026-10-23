import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseDocumentText } from './document';
import { checkJsonSchemaSamples } from './jsonschema';
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
