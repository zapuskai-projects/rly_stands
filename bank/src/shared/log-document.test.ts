import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LOG_INDEX_TEMPLATE, logIndexName, toLogDocument } from './log-document';
import type { LogEntry } from './logger';

const NO_CONTEXT = { label: null, bankTime: null };
const entry = (fields: Record<string, unknown>, message = 'operation status changed'): LogEntry => ({
  ts: '2026-10-23T09:15:00.000Z',
  level: 'info',
  service: 'bank-core',
  message,
  fields,
});

describe('документ журнала банка для Elasticsearch', () => {
  it('смена статуса: номер, статус, причина и роль лежат в своих полях', () => {
    const document = toLogDocument(
      entry({ operationId: 'op-1', operationNumber: 'ZB0000100003', status: 'REFUNDED', previousStatus: 'PROCESSING', reasonCode: 'SBP_TIMEOUT', channel: 'PHONE' }),
      NO_CONTEXT,
    );
    assert.equal(document['@timestamp'], '2026-10-23T09:15:00.000Z');
    assert.equal(document.role, 'core');
    assert.equal(document.service, 'bank-core');
    assert.equal(document.operationNumber, 'ZB0000100003');
    assert.equal(document.status, 'REFUNDED');
    assert.equal(document.reasonCode, 'SBP_TIMEOUT');
    assert.equal(document.previousStatus, 'PROCESSING');
    assert.deepEqual(JSON.parse(document.details as string), { channel: 'PHONE' });
  });

  it('числовой статус запроса уходит в httpStatus: статус операции и код ответа не делят поле', () => {
    const document = toLogDocument(entry({ requestId: 'r-1', method: 'POST', path: '/api/v1/transfers', status: 422, durationMs: 12, errorCode: 'INSUFFICIENT_FUNDS' }, 'request'), NO_CONTEXT);
    assert.equal(document.httpStatus, 422);
    assert.equal(document.status, undefined);
    assert.equal(document.durationMs, 12);
    assert.equal(document.errorCode, 'INSUFFICIENT_FUNDS');
    assert.equal(document.details, undefined);
  });

  it('поле code считается кодом ошибки, ошибка и метка сценария берутся из записи или из контекста', () => {
    const fromEntry = toLogDocument(entry({ code: 'UNDECLARED', error: 'boom', label: 'task-9' }, 'undeclared error status'), { label: 'scenario', bankTime: null });
    assert.equal(fromEntry.errorCode, 'UNDECLARED');
    assert.equal(fromEntry.error, 'boom');
    assert.equal(fromEntry.label, 'task-9');
    const fromContext = toLogDocument(entry({}, 'sbp dispatch'), { label: 'scenario', bankTime: new Date('2026-10-23T20:10:00.000Z') });
    assert.equal(fromContext.label, 'scenario');
    assert.equal(fromContext.bankTime, '2026-10-23T20:10:00.000Z');
  });

  it('время банка из самой записи сильнее времени из контекста', () => {
    const document = toLogDocument(entry({ bankTime: '2026-10-23T12:00:00.000+03:00' }), { label: null, bankTime: new Date(0) });
    assert.equal(document.bankTime, '2026-10-23T12:00:00.000+03:00');
  });

  it('остальные поля собираются в одну строку details, bigint и неопределённое не ломают её', () => {
    const document = toLogDocument(entry({ score: 72, rules: ['NIGHT'], big: 10n, skipped: undefined }, 'antifraud decision published'), NO_CONTEXT);
    assert.deepEqual(JSON.parse(document.details as string), { score: 72, rules: ['NIGHT'], big: '10' });
  });

  it('индекс называется по дню записи, шаблон описывает ключевые поля как keyword', () => {
    assert.equal(logIndexName('2026-10-23T23:59:59.000Z'), 'bank-logs-2026.10.23');
    assert.deepEqual(LOG_INDEX_TEMPLATE.index_patterns, ['bank-logs-*']);
    const properties = LOG_INDEX_TEMPLATE.template.mappings.properties;
    for (const name of ['reasonCode', 'status', 'operationId', 'operationNumber'] as const) assert.equal(properties[name].type, 'keyword');
  });
});
