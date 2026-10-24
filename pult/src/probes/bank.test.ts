import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { autopaymentRuns, BANK_EXECUTORS, requestRoute, statusClass, withRoutes, withTemplateFlag } from './bank';
import { hasFunding, resolveBankTime, resolvePersonaTimes } from './bank-api';
import { runActions, substituteResults } from './run';

type Seen = { method: string; url: string; secret: string | undefined; body: unknown };

let server: Server;
let dataDir = '';
const seen: Seen[] = [];

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text ? JSON.parse(text) : null));
  });
}

const OPERATION = {
  id: 'op-1',
  number: 'ZB0001',
  status: 'REJECTED',
  statusHistory: [{ status: 'CREATED', at: '2026-10-20T10:00:00+03:00' }],
  defects: [{ code: 'limit-boundary', details: { expected: 'ACCEPTED' } }],
  postings: [],
  antifraud: { score: 72, decision: 'REVIEW', rules: [{ code: 'NIGHT', points: 25 }] },
  notifications: [{ channel: 'SMS', beforeCompletion: true }, { channel: 'PUSH', beforeCompletion: false }],
};

const AUTOPAYMENTS = {
  templates: [{ id: 'tpl-1', name: 'Аренда' }],
  autopayments: [{ id: 'ap-1', status: 'ACTIVE', runs: [{ outcome: 'FAILED' }, { outcome: 'FAILED' }, { outcome: 'EXECUTED' }, { outcome: 'PENDING' }] }, { id: 'ap-2', status: 'FINISHED', runs: [] }],
};

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kit-bank-test-'));
  writeFileSync(join(dataDir, 'bank-secret'), 'topsecret\n');
  server = createServer(async (request, response) => {
    const body = await readBody(request);
    seen.push({ method: request.method ?? '', url: request.url ?? '', secret: request.headers['x-kit-secret'] as string | undefined, body });
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const url = request.url ?? '';
    if (request.headers['x-kit-secret'] !== 'topsecret') return send(404, { code: 'NOT_FOUND' });
    if (url.startsWith('/_kit/facts/operations/ZB0001')) return send(200, OPERATION);
    if (url.startsWith('/_kit/facts/operations/')) return send(404, { error: 'not found' });
    if (url.startsWith('/_kit/facts/operations')) return send(200, [OPERATION]);
    if (url.startsWith('/_kit/facts/ledger')) return send(200, { balanceKop: 100, postingsSumKop: 100, consistent: true, holdsKop: 0 });
    if (url.startsWith('/_kit/facts/requests')) return send(200, { requests: [{ method: 'POST', path: '/api/v1/transfers', status: 201 }] });
    if (url.startsWith('/_kit/facts/autopayments?phone=%2B79990000404')) return send(404, { code: 'NOT_FOUND' });
    if (url.startsWith('/_kit/facts/autopayments')) return send(200, AUTOPAYMENTS);
    if (url === '/_kit/actions/autopay-run') return send(200, { runId: 'run-1', attempt: 2, outcome: 'FAILED', operationId: null, operationNumber: null, reasonCode: 'INSUFFICIENT_FUNDS', autopaymentStatus: 'ACTIVE', nextRunOn: '2026-10-22' });
    if (url.startsWith('/_kit/facts/tariffs/NOPE')) return send(404, {});
    if (url.startsWith('/_kit/facts/tariffs/')) return send(200, { code: 'START', dailyLimitKop: 15000000 });
    if (url === '/_kit/actions/transfer') return send(201, { operationId: 'op-9', number: 'ZB0009', status: 'CREATED' });
    return send(200, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.KIT_BANK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/_kit`;
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.KIT_BANK_URL;
});

const ctx = () => ({ workDir: '/tmp', label: 'k7f3qa', dataDir });
const run = (key: string, params: Record<string, unknown>) => BANK_EXECUTORS[key]!(params, ctx());

describe('проверки банка', () => {
  it('операция: факты со всеми массивами, секрет уходит в заголовке', async () => {
    seen.length = 0;
    const facts = (await run('bank.operation', { id: 'ZB0001' })) as Record<string, unknown>;
    assert.equal(facts.exists, true);
    assert.equal((facts.defects as Array<{ code: string }>)[0]?.code, 'limit-boundary');
    assert.equal(seen[0]?.secret, 'topsecret');
  });

  it('несуществующая или пустая операция — exists: false без запроса при пустом номере', async () => {
    const missing = (await run('bank.operation', { id: 'ZB404' })) as Record<string, unknown>;
    assert.equal(missing.exists, false);
    assert.deepEqual(missing.defects, []);
    seen.length = 0;
    await run('bank.operation', { id: '  ' });
    assert.equal(seen.length, 0);
  });

  it('операции метки: список из массива, в запросе метка и статус', async () => {
    seen.length = 0;
    const facts = (await run('bank.operations', { label: 'k7f3qa', status: 'REJECTED' })) as { count: number };
    assert.equal(facts.count, 1);
    assert.equal(seen[0]?.url, '/_kit/facts/operations?label=k7f3qa&status=REJECTED');
  });

  it('уведомления и антифрод берутся из операции', async () => {
    const notifications = (await run('bank.notifications', { operationId: 'ZB0001' })) as Record<string, unknown>;
    assert.equal(notifications.count, 2);
    assert.equal(notifications.anyBeforeCompletion, true);
    const antifraud = (await run('bank.antifraud', { operationId: 'ZB0001' })) as Record<string, unknown>;
    assert.equal(antifraud.score, 72);
    assert.equal(((await run('bank.antifraud', { operationId: 'ZB404' })) as { exists: boolean }).exists, false);
  });

  it('книга, журнал запросов и тариф', async () => {
    assert.equal(((await run('bank.ledger', { account: '4081' })) as { consistent: boolean }).consistent, true);
    assert.deepEqual(((await run('bank.ledger', {})) as { inconsistent: unknown[] }).inconsistent, []);
    const journal = (await run('bank.requestLog', { label: 'k7f3qa' })) as { count: number; requests: Array<Record<string, unknown>> };
    assert.equal(journal.count, 1);
    assert.deepEqual([journal.requests[0]?.route, journal.requests[0]?.statusClass], ['/api/v1/transfers', '2xx']);
    assert.equal(((await run('bank.tariff', { code: 'START' })) as { exists: boolean }).exists, true);
    assert.equal(((await run('bank.tariff', { code: 'NOPE' })) as { exists: boolean }).exists, false);
  });

  it('автоплатежи: шаблоны, автоплатежи и счётчики запусков по итогам, телефон уходит в запросе', async () => {
    seen.length = 0;
    const facts = (await run('bank.autopayments', { phone: '+79990000001' })) as Record<string, unknown>;
    assert.equal(seen[0]?.url, '/_kit/facts/autopayments?phone=%2B79990000001');
    assert.deepEqual(
      ['count', 'templatesCount', 'runsCount', 'executedRuns', 'failedRuns', 'pendingRuns'].map((field) => facts[field]),
      [2, 1, 4, 1, 2, 1],
    );
    assert.equal((facts.autopayments as unknown[]).length, 2);
    assert.equal((facts.templates as unknown[]).length, 1);
    assert.equal((facts.runs as unknown[]).length, 4);
  });

  it('запуски автоплатежей одним списком: владелец, телефон клиента и коды сбоев на запуске', () => {
    const runs = autopaymentRuns([
      { id: 'ap-1', clientPhone: '+79990000001', runs: [{ id: 'r1', outcome: 'FAILED', defects: [{ code: 'autopay-no-retry', details: {} }] }, { id: 'r0', outcome: 'EXECUTED', defects: [] }] },
      { id: 'ap-2', clientPhone: '+79990000002', runs: [] },
    ]);
    assert.deepEqual(runs.map((run) => [(run as Record<string, unknown>).id, run.autopaymentId, run.clientPhone, run.defectCodes]), [
      ['r1', 'ap-1', '+79990000001', ['autopay-no-retry']],
      ['r0', 'ap-1', '+79990000001', []],
    ]);
  });

  it('журнал запросов: маршрут без идентификаторов и класс ответа', () => {
    const id = '5a1e7c3d-2b4f-4a6e-9c8d-1f0e2d3c4b5a';
    assert.equal(requestRoute(`/api/v1/templates/${id}/transfers`), '/api/v1/templates/{id}/transfers');
    assert.equal(requestRoute(`/api/v1/sandbox/autopayments/${id}/run`), '/api/v1/sandbox/autopayments/{id}/run');
    assert.equal(requestRoute('/api/v1/templates'), '/api/v1/templates');
    assert.equal(requestRoute(`/api/v1/operations/${id}`), '/api/v1/operations/{id}');
    assert.deepEqual([statusClass(201), statusClass(409), statusClass(500)], ['2xx', '4xx', '5xx']);
    assert.deepEqual(withRoutes([{ method: 'DELETE', path: `/api/v1/templates/${id}`, status: 204 }]), [
      { method: 'DELETE', path: `/api/v1/templates/${id}`, status: 204, route: '/api/v1/templates/{id}', statusClass: '2xx' },
    ]);
  });

  it('операции: признак «сделана по шаблону»', () => {
    assert.deepEqual(
      withTemplateFlag([{ number: 'A', templateId: 'tpl-1' }, { number: 'B', templateId: null }, { number: 'C' }]).map((item) => item.byTemplate),
      [true, false, false],
    );
  });

  it('автоплатежи до релиза 1.1 — понятная ошибка, а не пустые факты', async () => {
    await assert.rejects(run('bank.autopayments', { phone: '+79990000404' }), /доступны с релиза 1\.1/);
  });

  it('ручной запуск автоплатежа уходит с меткой попытки и возвращает итог попытки', async () => {
    seen.length = 0;
    const result = (await run('bank.autopayRun', { autopaymentId: 'ap-1' })) as Record<string, unknown>;
    assert.deepEqual(seen[0]?.body, { autopaymentId: 'ap-1', label: 'k7f3qa' });
    assert.deepEqual([result.attempt, result.outcome, result.reasonCode, result.autopaymentStatus, result.nextRunOn], [2, 'FAILED', 'INSUFFICIENT_FUNDS', 'ACTIVE', '2026-10-22']);
  });

  it('сценарий уходит с меткой попытки, сброс — по флагу', async () => {
    seen.length = 0;
    await run('bank.scenario', { reset: true, defects: ['limit-boundary'], sbpMode: 'TIMEOUT', bankTime: '23:40' });
    assert.deepEqual(seen.map((item) => item.url), ['/_kit/reset', '/_kit/scenario']);
    assert.deepEqual(seen[1]?.body, { label: 'k7f3qa', defects: ['limit-boundary'], sbpMode: 'TIMEOUT', bankTime: '23:40' });
  });

  it('релиз уходит в сценарий только когда задан, неизвестный отвергается до запроса', async () => {
    seen.length = 0;
    await run('bank.scenario', { release: '1.1' });
    assert.deepEqual((seen[0]?.body as { release?: string }).release, '1.1');
    seen.length = 0;
    await run('bank.scenario', {});
    assert.equal((seen[0]?.body as { release?: string }).release, undefined);
    seen.length = 0;
    await assert.rejects(run('bank.scenario', { reset: true, release: '2.0' }), /Релиз банка 2\.0 неизвестен/);
    assert.equal(seen.length, 0);
  });

  it('перевод возвращает номер операции, метка добавляется к телу', async () => {
    seen.length = 0;
    const result = (await run('bank.transfer', { phone: '+79990000001', amountKop: 500, idempotencyKey: 'k1' })) as Record<string, unknown>;
    assert.equal(result.number, 'ZB0009');
    assert.deepEqual(seen[0]?.body, { phone: '+79990000001', amountKop: 500, idempotencyKey: 'k1', label: 'k7f3qa' });
  });

  it('банк, не принявший секрет, отвечает 404 на всё: это сбой, а не «операции нет»', async () => {
    writeFileSync(join(dataDir, 'bank-secret'), 'wrong\n');
    try {
      await assert.rejects(run('bank.operation', { id: 'ZB404' }), /не принял секрет/);
    } finally {
      writeFileSync(join(dataDir, 'bank-secret'), 'topsecret\n');
    }
  });

  it('без секрета банка проверка не состоится с понятной причиной', async () => {
    await assert.rejects(
      BANK_EXECUTORS['bank.operation']!({ id: 'ZB0001' }, { workDir: '/tmp', label: 'a', dataDir: join(dataDir, 'none') }),
      /Секрет банка не найден/,
    );
  });
});

describe('результаты действий и баг-репорт эталона', () => {
  it('{{result.имя.поле}} подставляется в параметры следующих действий', () => {
    assert.deepEqual(
      substituteResults({ operationId: '{{result.transfer.number}}', nested: ['{{result.transfer.status}}'] }, { transfer: { number: 'ZB0009', status: 'CREATED' } }),
      { operationId: 'ZB0009', nested: ['CREATED'] },
    );
    assert.equal(substituteResults('{{result.none.x}}', {}), '');
  });

  it('перевод с именем и баг-репорт с его номером выполняются подряд', async () => {
    let saved: Record<string, string> | null = null;
    const failure = await runActions(
      [
        { action: 'bank.transfer', as: 'transfer', params: { phone: '+79990000001', amountKop: 500, idempotencyKey: 'k1' } },
        { action: 'platform.report', params: { title: 'Лимит', operationId: '{{result.transfer.number}}' } },
      ],
      {
        ...ctx(),
        saveReport: async (report) => {
          saved = report;
        },
      },
    );
    assert.equal(failure, null);
    assert.deepEqual(saved, { title: 'Лимит', operationId: 'ZB0009' });
  });

  it('баг-репорт вне попытки — понятная ошибка', async () => {
    const failure = await runActions([{ action: 'platform.report', params: { title: 'x' } }], ctx());
    assert.match(failure ?? '', /внутри попытки/);
  });
});

describe('время банка в сценарии', () => {
  it('noon — сегодняшний полдень по Москве; ISO-время и null идут как есть', () => {
    assert.equal(resolveBankTime('noon', new Date('2026-10-20T20:30:00Z')), '2026-10-20T12:00');
    assert.equal(resolveBankTime('noon', new Date('2026-10-20T21:30:00Z')), '2026-10-21T12:00');
    for (const inherited of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(resolveBankTime(inherited, new Date('2026-10-20T21:30:00Z')), inherited);
    }
    assert.equal(resolveBankTime('2026-10-21T23:40'), '2026-10-21T23:40');
    assert.equal(resolveBankTime(null), null);
    assert.equal(resolveBankTime(undefined), null);
  });

  it('noon и night со сдвигом в минутах: время идёт вперёд, сутки переходят', () => {
    const now = new Date('2026-10-20T09:00:00Z');
    assert.equal(resolveBankTime('noon+15m', now), '2026-10-20T12:15');
    assert.equal(resolveBankTime('noon+0m', now), '2026-10-20T12:00');
    assert.equal(resolveBankTime('night+30m', now), '2026-10-20T23:40');
    assert.equal(resolveBankTime('night+70m', now), '2026-10-21T00:20');
    assert.equal(resolveBankTime('2026-10-20T08:00+5m', now), '2026-10-20T08:00+5m');
    assert.equal(resolveBankTime('midnight+5m', now), 'midnight+5m');
  });

  it('night — сегодняшние 23:10 по Москве; после полуночи по Москве наступает следующий день', () => {
    assert.equal(resolveBankTime('night', new Date('2026-10-20T20:30:00Z')), '2026-10-20T23:10');
    assert.equal(resolveBankTime('night', new Date('2026-10-20T21:30:00Z')), '2026-10-21T23:10');
    assert.equal(resolveBankTime('night', new Date('2026-10-20T09:00:00Z')), '2026-10-20T23:10');
  });
});

describe('персоны сценария: время переводов прошлого', () => {
  it('пресет времени в history раскрывается так же, как время банка; остальные поля не трогаются', () => {
    const now = new Date('2026-10-20T09:00:00Z');
    const personas = [
      { phone: '+79001110001', topUpKop: 100, history: [{ at: 'night', amountKop: 14_000_000 }, { at: '2026-10-19T21:30', amountKop: 1 }] },
      { phone: '+79001110002', dailyLimitKop: 5 },
    ];
    assert.deepEqual(resolvePersonaTimes(personas, now), [
      { phone: '+79001110001', topUpKop: 100, history: [{ at: '2026-10-20T23:10', amountKop: 14_000_000 }, { at: '2026-10-19T21:30', amountKop: 1 }] },
      { phone: '+79001110002', dailyLimitKop: 5 },
    ]);
  });

  it('сценарий без reset не принимает пополнение и историю: запроса в банк нет', async () => {
    seen.length = 0;
    await assert.rejects(
      run('bank.scenario', { personas: [{ phone: '+79001110001', topUpKop: 100 }] }),
      /только с reset: true/,
    );
    assert.equal(seen.length, 0);
    await run('bank.scenario', { personas: [{ phone: '+79001110001', dailyLimitKop: 5 }] });
    assert.deepEqual(seen.map((item) => item.url), ['/_kit/scenario']);
  });

  it('hasFunding: пополнение и история видны, остальное нет', () => {
    assert.equal(hasFunding(undefined), false);
    assert.equal(hasFunding([{ phone: '+79001110002', dailyLimitKop: 5 }]), false);
    assert.equal(hasFunding([{ phone: '+79001110001', topUpKop: 100 }]), true);
    assert.equal(hasFunding([{ phone: '+79001110001', history: [] }]), true);
  });
});
