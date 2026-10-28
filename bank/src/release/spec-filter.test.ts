import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { PROBE_ASYNCAPI, PROBE_OPENAPI } from '../testing/release-spec';
import { filterSpec, specForRelease } from './spec-filter';

type Json = Record<string, unknown>;

function dig<T = unknown>(value: unknown, path: string): T {
  return path.split('.').reduce<unknown>((current, key) => (typeof current === 'object' && current !== null ? (current as Json)[key] : undefined), value) as T;
}

const openapi = (release: '1.0' | '1.1') => parse(specForRelease(PROBE_OPENAPI, release)) as Json;
const asyncapi = (release: '1.0' | '1.1') => parse(specForRelease(PROBE_ASYNCAPI, release)) as Json;

function danglingRefs(document: Json): string[] {
  const missing: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const target = dig(document, value.replace(/^#\//, '').split('/').join('.'));
        if (target === undefined) missing.push(value);
      } else visit(value);
    }
  };
  visit(document);
  return missing;
}

describe('контракт для текущего релиза', () => {
  it('служебный параметр (x-internal) не виден ни в одной операции и уходит из компонентов', () => {
    const spec = {
      openapi: '3.1.0',
      paths: { '/a': { get: { parameters: [{ $ref: '#/components/parameters/Label' }, { $ref: '#/components/parameters/Key' }], responses: { '200': { description: 'ok' } } } } },
      components: {
        parameters: {
          Label: { name: 'X-Attempt-Label', in: 'header', 'x-internal': true, schema: { type: 'string' } },
          Key: { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
        },
      },
    };
    const filtered = filterSpec(spec, '1.2') as { paths: { '/a': { get: { parameters: unknown[] } } }; components: { parameters: Record<string, unknown> } };
    assert.deepEqual(filtered.paths['/a'].get.parameters, [{ $ref: '#/components/parameters/Key' }]);
    assert.deepEqual(Object.keys(filtered.components.parameters), ['Key']);
  });

  it('настоящий контракт банка не показывает метку попытки', () => {
    const served = specForRelease(readFileSync(path.join(__dirname, '../../docs/openapi.yaml'), 'utf8'), '1.2');
    assert.equal(served.includes('X-Attempt-Label'), false);
    assert.ok(served.includes('Idempotency-Key'));
  });

  it('на 1.0 операции следующего релиза, их ответы и схемы вырезаны', () => {
    const document = openapi('1.0');
    assert.deepEqual(Object.keys(dig<Json>(document, 'paths')), ['/api/v1/ping']);
    assert.deepEqual(Object.keys(dig<Json>(document, 'components.schemas')).sort(), ['Ping', 'Unused']);
    assert.equal(dig(document, 'components.responses'), undefined);
    assert.equal(JSON.stringify(document).includes('probe'), false);
    assert.equal(JSON.stringify(document).includes('1.1'), false);
    assert.deepEqual(danglingRefs(document), []);
  });

  it('на 1.0 поле следующего релиза уходит из свойств и из обязательных', () => {
    const ping = dig<{ properties: Json; required: string[] }>(openapi('1.0'), 'components.schemas.Ping');
    assert.deepEqual(Object.keys(ping.properties), ['status']);
    assert.deepEqual(ping.required, ['status']);
  });

  it('схема, на которую никто не ссылался и до этого, остаётся', () => {
    assert.ok(dig(openapi('1.0'), 'components.schemas.Unused'));
  });

  it('на 1.1 всё на месте, документ отдаётся как в файле', () => {
    assert.equal(specForRelease(PROBE_OPENAPI, '1.1'), PROBE_OPENAPI);
    const document = openapi('1.1');
    assert.deepEqual(Object.keys(dig<Json>(document, 'paths')), ['/api/v1/ping', '/api/v1/release-probe']);
    assert.deepEqual(danglingRefs(document), []);
  });

  it('события на 1.0 без канала и поля следующего релиза', () => {
    const document = asyncapi('1.0');
    assert.deepEqual(Object.keys(dig<Json>(document, 'channels')), ['bank.probe.created']);
    assert.deepEqual(Object.keys(dig<Json>(document, 'components.messages')), ['ProbeCreated']);
    assert.deepEqual(Object.keys(dig<Json>(document, 'components.schemas')), ['ProbeCreated']);
    assert.deepEqual(Object.keys(dig<Json>(document, 'components.schemas.ProbeCreated.properties')), ['id']);
    assert.equal(JSON.stringify(document).includes('Later'), false);
    assert.deepEqual(danglingRefs(document), []);
  });

  it('на 1.1 события полные', () => {
    const document = asyncapi('1.1');
    assert.deepEqual(Object.keys(dig<Json>(document, 'channels')), ['bank.probe.created', 'bank.probe.later']);
    assert.ok(dig(document, 'components.schemas.ProbeCreated.properties.templateId'));
  });

  it('список вариантов, где остался один, превращается в обычную ссылку; на 1.1 остаётся список', () => {
    const source = `asyncapi: '2.6.0'
channels:
  a:
    subscribe:
      message:
        oneOf:
          - $ref: '#/components/messages/Old'
          - $ref: '#/components/messages/New'
            x-release: '1.1'
components:
  messages:
    Old:
      name: Old
    New:
      name: New
`;
    const first = parse(specForRelease(source, '1.0')) as Json;
    assert.deepEqual(dig(first, 'channels.a.subscribe.message'), { $ref: '#/components/messages/Old' });
    assert.deepEqual(Object.keys(dig<Json>(first, 'components.messages')), ['Old']);
    assert.equal(dig<unknown[]>(parse(specForRelease(source, '1.1')), 'channels.a.subscribe.message.oneOf').length, 2);
  });

  it('неизвестный релиз в пометке — ошибка, а не молчаливый показ', () => {
    assert.throws(() => filterSpec({ paths: { '/a': { get: { 'x-release': '9.9' } } } }, '1.0'), /9\.9/);
  });
});

describe('значения перечислений следующих релизов', () => {
  const source = `openapi: 3.1.0
components:
  schemas:
    Kind:
      type: string
      enum: [A, B, C]
      x-release-values:
        B: '1.1'
        C: '1.2'
    Plain:
      type: string
      enum: [X, Y]
`;
  const kind = (release: '1.0' | '1.1' | '1.2') => dig<Json>(parse(specForRelease(source, release)), 'components.schemas.Kind');

  it('на 1.0 остаются значения без пометки и сама пометка уходит', () => {
    assert.deepEqual(kind('1.0'), { type: 'string', enum: ['A'] });
  });

  it('на 1.1 появляются значения этого релиза, пометка остаётся только у значений следующих', () => {
    assert.deepEqual(kind('1.1'), { type: 'string', enum: ['A', 'B'], 'x-release-values': { B: '1.1' } });
  });

  it('на 1.2 все значения на месте, перечисление без пометки не трогается', () => {
    assert.deepEqual(kind('1.2').enum, ['A', 'B', 'C']);
    assert.deepEqual(dig<Json>(parse(specForRelease(source, '1.0')), 'components.schemas.Plain'), { type: 'string', enum: ['X', 'Y'] });
  });

  it('неизвестный релиз в пометке значений — ошибка', () => {
    assert.throws(() => specForRelease(source.replace("C: '1.2'", "C: '9.9'"), '1.0'), /9\.9/);
  });
});
