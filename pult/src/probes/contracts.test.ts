import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDocumentText } from './document';
import { checkJsonSchemaSamples, describeJsonSchema } from './jsonschema';
import { checkOpenApiSamples, describeOpenApi } from './openapi';

const OPENAPI = `openapi: 3.0.3
info:
  title: k3x9ab Учебный API
  version: 1.0.0
paths:
  /documents:
    post:
      operationId: createDocument
      parameters:
        - name: dryRun
          in: query
          required: false
          schema:
            type: boolean
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Document'
      responses:
        '201':
          description: создано
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Document'
        '400':
          description: ошибка
components:
  schemas:
    Document:
      type: object
      required: [id, status]
      properties:
        id:
          type: integer
          format: int64
        status:
          type: string
          enum: [draft, signed]
        note:
          type: string
          nullable: true
`;

const OPENAPI_BODIES = `openapi: 3.0.3
info:
  title: Партнёрский API
  version: 1.0.0
paths:
  /partner/v1/phone-transfers:
    post:
      operationId: createPhoneTransfer
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PhoneTransferRequest'
      responses:
        '201':
          description: создано
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Operation'
        '422':
          description: ошибка данных
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '500':
          description: сбой
components:
  schemas:
    PhoneTransferRequest:
      type: object
      required: [fromAccount, recipientPhone, amount]
      properties:
        fromAccount:
          type: string
        recipientPhone:
          type: string
          pattern: '^\\+79[0-9]{9}$'
        amount:
          type: integer
          minimum: 1
          maximum: 1000000
    Operation:
      type: object
      properties:
        number:
          type: string
        status:
          type: string
    Error:
      type: object
      required: [code]
      properties:
        code:
          type: string
        message:
          type: string
`;

const SCHEMA = `{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.local/k3x9ab.document.signed",
  "title": "Документ подписан",
  "type": "object",
  "required": ["id", "signedAt"],
  "properties": {
    "id": { "type": "string", "format": "uuid" },
    "signedAt": { "type": "string", "format": "date-time" },
    "kind": { "enum": ["contract", "act"] }
  },
  "additionalProperties": false
}`;

type Field = { name: string; type: string; required: boolean; minimum: number | null; maximum: number | null; pattern: string | null };
type Body = { required: string[]; fields: Field[] };
type Method = {
  requestBody: { required: boolean; schema: Body | null } | null;
  responseBodies: Array<{ status: string; schema: Body | null }>;
};

describe('openapi.describe', () => {
  it('методы, коды ответов и схемы с полями', () => {
    const facts = describeOpenApi(parseDocumentText(OPENAPI));
    assert.equal(facts.parsed, true);
    assert.equal(facts.info.title, 'k3x9ab Учебный API');
    const [method] = facts.methods;
    assert.deepEqual(
      { ...method, requestBody: undefined, responseBodies: undefined },
      {
        path: '/documents',
        method: 'post',
        operationId: 'createDocument',
        parameters: [{ name: 'dryRun', in: 'query', required: false }],
        responses: ['201', '400'],
        requestBody: undefined,
        responseBodies: undefined,
      },
    );
    const document = facts.schemas.find((schema) => schema.name === 'Document');
    assert.deepEqual(
      document?.fields.map((field) => [field.name, field.type, field.required, field.format]),
      [
        ['id', 'integer', true, 'int64'],
        ['status', 'string', true, null],
        ['note', 'string', false, null],
      ],
    );
    assert.deepEqual(document?.fields[1]?.enum, ['draft', 'signed']);
  });

  it('тело запроса и тела ответов привязаны к методу: обязательные поля, типы, границы, формат', () => {
    const [method] = describeOpenApi(parseDocumentText(OPENAPI_BODIES)).methods as unknown as Method[];
    assert.equal(method?.requestBody?.required, true);
    assert.deepEqual(method?.requestBody?.schema?.required, ['fromAccount', 'recipientPhone', 'amount']);
    const amount = method?.requestBody?.schema?.fields.find((field) => field.name === 'amount');
    assert.deepEqual(
      [amount?.type, amount?.required, amount?.minimum, amount?.maximum],
      ['integer', true, 1, 1000000],
    );
    const phone = method?.requestBody?.schema?.fields.find((field) => field.name === 'recipientPhone');
    assert.equal(phone?.pattern, '^\\+79[0-9]{9}$');
    assert.deepEqual(
      method?.responseBodies?.map((body) => [body.status, body.schema?.fields.map((field) => field.name) ?? null]),
      [
        ['201', ['number', 'status']],
        ['422', ['code', 'message']],
        ['500', null],
      ],
    );
  });

  it('метод без тела запроса отдаёт requestBody=null', () => {
    const [method] = describeOpenApi(
      parseDocumentText(OPENAPI_BODIES.replace(/      requestBody:[\s\S]*?      responses:/, '      responses:')),
    ).methods as unknown as Method[];
    assert.equal(method?.requestBody, null);
  });

  it('битый YAML и не OpenAPI дают parsed=false с причиной', () => {
    assert.equal(describeOpenApi(parseDocumentText('openapi: [')).parsed, false);
    const notOpenApi = describeOpenApi(parseDocumentText('title: x'));
    assert.equal(notOpenApi.parsed, false);
    assert.ok(notOpenApi.errors[0]?.includes('openapi'));
  });
});

describe('openapi.samples', () => {
  const loaded = parseDocumentText(OPENAPI);
  const base = { path: '/documents', method: 'post' };

  it('валидный и невалидный пример проверяются по схеме тела', () => {
    const result = checkOpenApiSamples(loaded, [
      { ...base, part: 'request', body: { id: 1, status: 'draft' }, expectValid: true },
      { ...base, part: 'request', body: { id: 'x', status: 'draft' }, expectValid: false },
      { ...base, part: 'request', body: { id: 1, status: 'lost' }, expectValid: false },
      { ...base, part: 'response', status: '201', body: { id: 2, status: 'signed', note: null }, expectValid: true },
    ]);
    assert.equal(result.allOk, true);
    assert.deepEqual(result.results.map((item) => item.valid), [true, false, false, true]);
    assert.ok(result.results[1]?.errors.length);
  });

  it('пример, который должен быть валидным, но не проходит схему, роняет итог', () => {
    const result = checkOpenApiSamples(loaded, [
      { ...base, part: 'request', body: { status: 'draft' }, expectValid: true },
    ]);
    assert.equal(result.allOk, false);
    assert.equal(result.results[0]?.ok, false);
    assert.match(result.results[0]?.errors.join(' ') ?? '', /id/);
  });

  it('нет такой операции или схемы — пример не засчитывается даже при expectValid=false', () => {
    const result = checkOpenApiSamples(loaded, [
      { path: '/missing', method: 'get', part: 'response', body: {}, expectValid: false },
    ]);
    assert.equal(result.results[0]?.ok, false);
    assert.match(result.results[0]?.errors[0] ?? '', /нет схемы/);
  });

  it('непрочитанный файл не засчитывает ни одного примера', () => {
    const result = checkOpenApiSamples({ ok: false, errors: ['файла work/openapi.yaml нет'] }, [
      { ...base, part: 'request', body: {}, expectValid: false },
    ]);
    assert.equal(result.allOk, false);
  });
});

describe('jsonschema', () => {
  const loaded = parseDocumentText(SCHEMA);

  it('describe отдаёт $id, обязательные поля, формат и enum', () => {
    const facts = describeJsonSchema(loaded);
    assert.equal(facts.$id, 'https://example.local/k3x9ab.document.signed');
    assert.deepEqual(facts.required, ['id', 'signedAt']);
    assert.deepEqual(
      facts.properties.map((field) => [field.name, field.type, field.required, field.format]),
      [
        ['id', 'string', true, 'uuid'],
        ['signedAt', 'string', true, 'date-time'],
        ['kind', 'string', false, null],
      ],
    );
  });

  it('describe отдаёт ограничения списков и запрет лишних свойств', () => {
    const facts = describeJsonSchema(
      parseDocumentText(`{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "signers": { "type": "array", "minItems": 1, "maxItems": 5, "items": { "type": "object", "required": ["fullName"], "properties": { "fullName": { "type": "string" } } } },
    "meta": { "type": "object", "additionalProperties": true },
    "tag": { "type": "string" }
  }
}`),
    );
    assert.equal(facts.additionalProperties, false);
    const byName = Object.fromEntries(facts.properties.map((field) => [field.name, field]));
    assert.equal(byName.signers?.minItems, 1);
    assert.equal(byName.signers?.maxItems, 5);
    assert.equal(byName['signers[].fullName']?.required, true);
    assert.equal(byName.meta?.additionalProperties, true);
    assert.equal(byName.tag?.additionalProperties, null);
    assert.equal(byName.tag?.minItems, null);
    assert.equal(describeJsonSchema(parseDocumentText('{"type":"object","additionalProperties":{"type":"string"}}')).additionalProperties, true);
    assert.equal(describeJsonSchema(parseDocumentText('{"type":"object"}')).additionalProperties, null);
  });

  it('валидный и невалидный пример по draft 2020-12', () => {
    const result = checkJsonSchemaSamples(loaded, [
      { data: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', signedAt: '2026-10-20T10:00:00Z', kind: 'act' }, expectValid: true },
      { data: { id: 'not-a-uuid', signedAt: '2026-10-20T10:00:00Z' }, expectValid: false },
      { data: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', signedAt: 'вчера' }, expectValid: false },
      { data: { id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', signedAt: '2026-10-20T10:00:00Z', extra: 1 }, expectValid: false },
    ]);
    assert.equal(result.allOk, true);
    assert.deepEqual(result.results.map((item) => item.valid), [true, false, false, false]);
  });

  it('схема draft-07 тоже разбирается', () => {
    const draft7 = parseDocumentText('{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","required":["a"]}');
    const result = checkJsonSchemaSamples(draft7, [
      { data: { a: 1 }, expectValid: true },
      { data: {}, expectValid: false },
    ]);
    assert.equal(result.allOk, true);
  });

  it('нечитаемая схема не засчитывает примеры', () => {
    const result = checkJsonSchemaSamples(parseDocumentText('{"type": 5}'), [{ data: 1, expectValid: true }]);
    assert.equal(result.allOk, false);
  });
});
