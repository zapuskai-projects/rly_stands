import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import type { Pool } from 'pg';
import { BankClock } from '../clock/bank-clock';
import { activeScenarioLabel, requestContext } from './request-context';

function fakePool(label: string | null | 'error', calls: string[] = []): Pool {
  return {
    query: async (sql: string) => {
      calls.push(sql);
      if (label === 'error') throw new Error('база недоступна');
      return { rows: [{ label }] };
    },
  } as unknown as Pool;
}

async function run(pool: Pool, url: string, headers: Record<string, string>) {
  const clock = new BankClock(() => Date.parse('2026-10-20T09:00:00Z'));
  const res = { locals: {} as Record<string, unknown>, setHeader: () => undefined } as unknown as Response;
  const req = { originalUrl: url, headers } as unknown as Request;
  await new Promise<void>((resolve) => requestContext(clock, pool)(req, res, resolve as NextFunction));
  return res.locals.attemptLabel;
}

describe('метка попытки запроса', () => {
  it('заголовок X-Attempt-Label главнее метки сценария и сценарий не читается', async () => {
    const calls: string[] = [];
    assert.equal(await run(fakePool('scenario-1', calls), '/api/v1/transfers', { 'x-attempt-label': 'header-1' }), 'header-1');
    assert.equal(calls.length, 0);
  });

  it('без заголовка запрос к API берёт метку активного сценария', async () => {
    assert.equal(await run(fakePool('scenario-1'), '/api/v1/transfers', {}), 'scenario-1');
  });

  it('негодный заголовок считается отсутствующим и тоже уступает метке сценария', async () => {
    assert.equal(await run(fakePool('scenario-1'), '/api/v1/accounts', { 'x-attempt-label': 'плохая метка!' }), 'scenario-1');
  });

  it('сценария нет или метка пуста — запрос без метки', async () => {
    assert.equal(await run(fakePool(null), '/api/v1/accounts', {}), null);
    assert.equal(await run(fakePool(''), '/api/v1/accounts', {}), null);
  });

  it('ошибка чтения сценария не ломает запрос', async () => {
    assert.equal(await run(fakePool('error'), '/api/v1/accounts', {}), null);
  });

  it('вне API (экраны, документы, служебные маршруты) сценарий не читается', async () => {
    const calls: string[] = [];
    assert.equal(await run(fakePool('scenario-1', calls), '/office', {}), null);
    assert.equal(await run(fakePool('scenario-1', calls), '/_kit/facts/ledger', {}), null);
    assert.equal(calls.length, 0);
  });

  it('метка сценария читается из базы с проверкой формата', async () => {
    assert.equal(await activeScenarioLabel(fakePool('ok.label:1')), 'ok.label:1');
    assert.equal(await activeScenarioLabel(fakePool('has space')), null);
  });
});
