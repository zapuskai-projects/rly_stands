import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { DOCS_DIR } from '../config';
import { specForRelease } from './spec-filter';

type Json = Record<string, unknown>;

const openapi = readFileSync(path.join(DOCS_DIR, 'openapi.yaml'), 'utf8');
const asyncapi = readFileSync(path.join(DOCS_DIR, 'asyncapi.yaml'), 'utf8');

const TRACES_OPENAPI = /шаблон|автоплат|template|autopay|x-release|1\.1/i;
const TRACES_ASYNCAPI = /шаблон|автоплат|template|autopay|x-release|1\.1/i;

function refs(document: unknown): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else visit(value);
    }
  };
  visit(document);
  return found;
}

function resolves(document: Json, ref: string): boolean {
  return ref.replace(/^#\//, '').split('/').reduce<unknown>((current, key) => (typeof current === 'object' && current !== null ? (current as Json)[key] : undefined), document) !== undefined;
}

describe('настоящие контракт и события банка на релизе 1.0', () => {
  it('контракт API не содержит ни следа релиза 1.1: ни путей, ни полей, ни слов, ни пометок', () => {
    const text = specForRelease(openapi, '1.0');
    assert.deepEqual(text.match(TRACES_OPENAPI), null);
    const document = parse(text) as Json;
    const full = parse(openapi) as { paths: Record<string, Record<string, Json>> };
    const firstRelease = Object.entries(full.paths).filter(([, item]) => Object.values(item).some((operation) => operation['x-release'] === undefined)).map(([route]) => route);
    assert.deepEqual(Object.keys(document.paths as Json), firstRelease);
    assert.equal(firstRelease.length, 29);
    assert.deepEqual(refs(document).filter((ref) => !resolves(document, ref)), []);
  });

  it('события не содержат ни следа релиза 1.1, уведомления остаются одним сообщением', () => {
    const text = specForRelease(asyncapi, '1.0');
    assert.deepEqual(text.match(TRACES_ASYNCAPI), null);
    const document = parse(text) as { channels: Record<string, { subscribe: { message: Json } }> };
    assert.deepEqual(Object.keys(document.channels).sort(), ['bank.antifraud.decisions', 'bank.notifications', 'bank.payments.created', 'bank.payments.status-changed']);
    assert.deepEqual(document.channels['bank.notifications']?.subscribe.message, { $ref: '#/components/messages/Notification' });
    assert.deepEqual(refs(document).filter((ref) => !resolves(document as unknown as Json, ref)), []);
  });
});

describe('настоящие контракт и события банка на релизе 1.1', () => {
  it('появляются шаблоны, автоплатежи, поле templateId и канал исполнения автоплатежа', () => {
    const document = parse(specForRelease(openapi, '1.1')) as { paths: Json; components: { schemas: Json } };
    for (const route of ['/api/v1/templates', '/api/v1/templates/{templateId}/transfers', '/api/v1/autopayments/{autopaymentId}/runs', '/api/v1/sandbox/autopayments/{autopaymentId}/run', '/api/v1/office/clients/{clientId}/autopayments']) {
      assert.ok(route in document.paths, route);
    }
    assert.ok('templateId' in ((document.components.schemas.Operation as Json).properties as Json));
    const events = parse(specForRelease(asyncapi, '1.1')) as { channels: Record<string, Json> };
    assert.ok('bank.autopayments.executed' in events.channels);
    assert.deepEqual(Object.keys(events.channels).length, 5);
    assert.equal(((events.channels['bank.notifications']?.subscribe as Json).message as { oneOf: unknown[] }).oneOf.length, 2);
  });
});

const TRACES_QR = /qr|партнёр|partner|x-release-values|1\.2/i;

describe('настоящие контракт и события банка на релизах 1.0 и 1.1 без оплаты по QR', () => {
  for (const release of ['1.0', '1.1'] as const) {
    it(`релиз ${release}: ни путей, ни значений вида операции, ни поля qrId, ни слов`, () => {
      const text = specForRelease(openapi, release);
      assert.deepEqual(text.match(TRACES_QR), null);
      const document = parse(text) as { paths: Json; components: { schemas: Json } };
      assert.deepEqual(Object.keys(document.paths).filter((route) => /qr/i.test(route)), []);
      assert.deepEqual((document.components.schemas.OperationType as Json).enum, ['OWN_TRANSFER', 'PHONE_TRANSFER']);
      assert.equal('qrId' in ((document.components.schemas.Operation as Json).properties as Json), false);
      assert.deepEqual(refs(document).filter((ref) => !resolves(document, ref)), []);
      const events = specForRelease(asyncapi, release);
      assert.deepEqual(events.match(TRACES_QR), null);
      const eventsDocument = parse(events) as Json;
      assert.deepEqual(refs(eventsDocument).filter((ref) => !resolves(eventsDocument, ref)), []);
    });
  }
});

describe('настоящие контракт и события банка на релизе 1.2', () => {
  it('появляются оплата по QR, вид операции QR_PAYMENT, поле qrId и тип события', () => {
    const document = parse(specForRelease(openapi, '1.2')) as { paths: Json; components: { schemas: Json } };
    for (const route of ['/api/v1/qr-payments', '/api/v1/qr-payments/lookup']) assert.ok(route in document.paths, route);
    assert.deepEqual((document.components.schemas.OperationType as Json).enum, ['OWN_TRANSFER', 'PHONE_TRANSFER', 'QR_PAYMENT', 'QR_REFUND']);
    assert.ok('qrId' in ((document.components.schemas.Operation as Json).properties as Json));
    for (const name of ['QrPaymentRequest', 'QrPurchase', 'QrStatus']) assert.ok(name in document.components.schemas, name);
    assert.deepEqual(refs(document).filter((ref) => !resolves(document, ref)), []);
    const events = parse(specForRelease(asyncapi, '1.2')) as { components: { schemas: Json } };
    const created = events.components.schemas.PaymentCreated as { properties: Json };
    assert.deepEqual((created.properties.type as Json).enum, ['OWN_TRANSFER', 'PHONE_TRANSFER', 'QR_PAYMENT', 'QR_REFUND']);
    assert.ok('qrId' in created.properties);
  });
});
