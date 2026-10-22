import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { transitionsOf, withRunId } from './bank-run';
import { EXECUTORS } from './registry';

type Call = { method: string; url: string; body: Record<string, unknown> | null };
type StubOperation = { id: string; number: string; plan: string[]; reads: number; amountKop: number };

let server: Server;
let dataDir = '';
let calls: Call[] = [];
let operations: StubOperation[] = [];
let plans: string[][] = [];
let clients = 0;
const FEES: Record<number, number> = { 14000000: 0, 3000000: 10000 };

function readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => resolve(text ? (JSON.parse(text) as Record<string, unknown>) : null));
  });
}

function factOf(operation: StubOperation) {
  const index = Math.min(operation.reads, operation.plan.length - 1);
  operation.reads += 1;
  const shown = operation.plan.slice(0, index + 1);
  return {
    id: operation.id,
    number: operation.number,
    status: shown.at(-1),
    route: 'SBP',
    amountKop: operation.amountKop,
    feeKop: FEES[operation.amountKop] ?? 0,
    reasonCode: shown.at(-1) === 'REFUNDED' ? 'SBP_TIMEOUT' : null,
    statusHistory: shown.map((status) => ({ status, at: '2026-10-20T10:00:00+03:00', reasonCode: null })),
  };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'kit-bank-run-'));
  writeFileSync(join(dataDir, 'bank-secret'), 'topsecret\n');
  process.env.KIT_BANK_POLL_MS = '10';
  process.env.KIT_BANK_CLOCK_SYNC_MS = '10';
  server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = request.url ?? '';
    calls.push({ method: request.method ?? '', url, body });
    const send = (status: number, payload: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    if (url === '/_kit/actions/transfer') {
      const operation: StubOperation = {
        id: `op-${operations.length + 1}`,
        number: `ZB000${operations.length + 1}`,
        plan: plans[operations.length] ?? ['CREATED', 'CHECKING', 'COMPLETED'],
        reads: 0,
        amountKop: Number(body?.amountKop),
      };
      operations.push(operation);
      return send(200, { operationId: operation.id, number: operation.number, status: 'CHECKING' });
    }
    if (url.startsWith('/_kit/facts/operations/')) {
      const found = operations.find((item) => item.id === url.split('/').pop());
      return found ? send(200, factOf(found)) : send(404, {});
    }
    if (url === '/_kit/actions/check-client') {
      clients += 1;
      return send(200, { phone: `+7999000${String(clients).padStart(4, '0')}`, accountNumber: `4081781000000000${String(clients).padStart(4, '0')}` });
    }
    if (url === '/_kit/actions/review') {
      const found = operations.find((item) => item.id === body?.operationId);
      if (found) found.plan = [...found.plan.slice(0, found.reads), 'PROCESSING', 'COMPLETED'];
      return send(200, { operationId: body?.operationId, state: 'APPROVED' });
    }
    return send(200, {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.KIT_BANK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/_kit`;
});

after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.KIT_BANK_URL;
  delete process.env.KIT_BANK_POLL_MS;
  delete process.env.KIT_BANK_CLOCK_SYNC_MS;
});

beforeEach(() => {
  calls = [];
  operations = [];
  plans = [];
  clients = 0;
});

afterEach(() => undefined);

const run = (params: Record<string, unknown>) =>
  EXECUTORS['bank.run']!(params, { workDir: '/tmp', label: 'k7f3qa', dataDir }) as Promise<{
    completed: boolean;
    timedOut: boolean;
    client: { phone: string; accountNumber: string } | null;
    recipient: { phone: string; accountNumber: string } | null;
    operations: Array<{
      number: string;
      status: string;
      feeKop: number;
      transitions: string[];
    }>;
    transitions: string[];
  }>;

const transfer = (amountKop: number, key = 'run-key-1') => ({
  transfer: { phone: '+79001110002', toPhone: '+79001110001', amountKop, idempotencyKey: key },
});

describe('чистые функции прогона банка', () => {
  it('ключ повтора получает суффикс прогона и не длиннее 64 знаков', () => {
    assert.equal(withRunId('run-k7f3qa-1', 'ab12'), 'run-k7f3qa-1-ab12');
    assert.equal(withRunId('x'.repeat(80), 'ab12').length, 64);
  });

  it('переходы — пары соседних статусов истории', () => {
    assert.deepEqual(transitionsOf([{ status: 'CREATED' }, { status: 'CHECKING' }, { status: 'PROCESSING' }]), [
      'CREATED -> CHECKING',
      'CHECKING -> PROCESSING',
    ]);
    assert.deepEqual(transitionsOf([{ status: 'CREATED' }]), []);
    assert.deepEqual(transitionsOf(undefined), []);
  });
});

describe('bank.run', () => {
  it('перевод ждёт конечного статуса; отдаёт операцию с историей, комиссией и переходами', async () => {
    plans = [['CREATED', 'CHECKING', 'PROCESSING', 'COMPLETED']];
    const facts = await run({ steps: [transfer(3000000)] });
    assert.equal(facts.completed, true);
    assert.equal(facts.timedOut, false);
    assert.equal(facts.operations.length, 1);
    const [operation] = facts.operations;
    assert.equal(operation?.status, 'COMPLETED');
    assert.equal(operation?.feeKop, 10000);
    assert.equal(operation?.number, 'ZB0001');
    assert.deepEqual(operation?.transitions, [
      'CREATED -> CHECKING',
      'CHECKING -> PROCESSING',
      'PROCESSING -> COMPLETED',
    ]);
    assert.deepEqual(facts.transitions, operation?.transitions);
    const sent = calls.find((call) => call.url === '/_kit/actions/transfer');
    assert.match(String(sent?.body?.idempotencyKey), /^run-key-1-[0-9a-f]{4}$/);
    assert.equal(sent?.body?.label, 'k7f3qa');
  });

  it('сценарий, перевод и пауза идут по порядку, сценарий уходит с меткой попытки', async () => {
    await run({
      steps: [{ scenario: { sbpMode: 'REJECT', defects: [] } }, transfer(14000000), { wait: 1 }],
      timeoutMs: 5000,
    });
    assert.deepEqual(
      calls.filter((call) => call.method === 'POST').map((call) => call.url),
      ['/_kit/scenario', '/_kit/actions/transfer'],
    );
    const scenario = calls[0]?.body;
    assert.equal(scenario?.label, 'k7f3qa');
    assert.equal(scenario?.sbpMode, 'REJECT');
  });

  it('перевод на ручной проверке ждёт решения оператора и после одобрения доходит до конца', async () => {
    plans = [['CREATED', 'CHECKING', 'ON_REVIEW', 'ON_REVIEW']];
    const facts = await run({ steps: [transfer(14000000), { review: { decision: 'APPROVE', comment: 'Проверено' } }] });
    const review = calls.find((call) => call.url === '/_kit/actions/review');
    assert.deepEqual(review?.body, { operationId: 'op-1', decision: 'APPROVE', comment: 'Проверено' });
    assert.equal(facts.operations[0]?.status, 'COMPLETED');
    assert.ok(facts.transitions.includes('ON_REVIEW -> PROCESSING'));
  });

  it('решение по операции не на проверке пропускается без обращения к банку', async () => {
    const facts = await run({ steps: [transfer(14000000), { review: { decision: 'APPROVE' } }] });
    assert.equal(facts.operations[0]?.status, 'COMPLETED');
    assert.equal(calls.some((call) => call.url === '/_kit/actions/review'), false);
  });

  it('решение оператора до перевода — сбой проверки с понятной причиной', async () => {
    await assert.rejects(run({ steps: [{ review: { decision: 'APPROVE' } }] }), /раньше любого перевода/);
  });

  it('операция, не дошедшая до конца за отведённое время, даёт timedOut без падения', async () => {
    plans = [['CREATED', 'CHECKING', 'PROCESSING']];
    const facts = await run({ steps: [transfer(14000000), transfer(3000000, 'run-key-2')], timeoutMs: 1000 });
    assert.equal(facts.completed, false);
    assert.equal(facts.timedOut, true);
    assert.equal(facts.operations.length, 1);
    assert.equal(facts.operations[0]?.status, 'PROCESSING');
  });

  it('технический клиент создаётся на каждый прогон с нужным тарифом и остатком, перевод идёт с его телефона', async () => {
    const params = {
      client: { tariffCode: 'START', balanceKop: 3_000_000 },
      steps: [{ transfer: { phone: 'client', toPhone: '+79001110001', amountKop: 100_000, idempotencyKey: 'run-key-1' } }],
    };
    const first = await run(params);
    const second = await run(params);
    const created = calls.filter((call) => call.url === '/_kit/actions/check-client');
    assert.equal(created.length, 2);
    assert.deepEqual(created[0]?.body, { tariffCode: 'START', balanceKop: 3_000_000 });
    assert.notEqual(first.client?.phone, second.client?.phone);
    const sent = calls.filter((call) => call.url === '/_kit/actions/transfer');
    assert.equal(sent[0]?.body?.phone, first.client?.phone);
    assert.equal(sent[1]?.body?.phone, second.client?.phone);
    assert.match(String(first.client?.accountNumber), /^[0-9]{20}$/);
  });

  it('получатель прогона — второй технический клиент, перевод идёт на его телефон', async () => {
    const facts = await run({
      client: { tariffCode: 'START', balanceKop: 3_000_000 },
      recipient: { tariffCode: 'START', balanceKop: 100 },
      steps: [{ transfer: { phone: 'client', toPhone: 'recipient', amountKop: 100_000, idempotencyKey: 'run-key-1' } }],
    });
    const created = calls.filter((call) => call.url === '/_kit/actions/check-client');
    assert.deepEqual(created.map((call) => call.body), [
      { tariffCode: 'START', balanceKop: 3_000_000 },
      { tariffCode: 'START', balanceKop: 100 },
    ]);
    assert.notEqual(facts.client?.phone, facts.recipient?.phone);
    const sent = calls.find((call) => call.url === '/_kit/actions/transfer');
    assert.equal(sent?.body?.phone, facts.client?.phone);
    assert.equal(sent?.body?.toPhone, facts.recipient?.phone);
  });

  it('перевод получателю прогона без самого получателя — сбой с понятной причиной', async () => {
    await assert.rejects(
      run({
        client: { tariffCode: 'START', balanceKop: 3_000_000 },
        steps: [{ transfer: { phone: 'client', toPhone: 'recipient', amountKop: 100, idempotencyKey: 'run-key-1' } }],
      }),
      /получатель не задан/,
    );
    assert.equal(calls.some((call) => call.url === '/_kit/actions/transfer'), false);
  });

  it('перевод от клиента прогона без самого клиента — сбой с понятной причиной, до банка дело не доходит', async () => {
    await assert.rejects(
      run({ steps: [{ transfer: { phone: 'client', toPhone: '+79001110001', amountKop: 100, idempotencyKey: 'run-key-1' } }] }),
      /клиент не задан/,
    );
    assert.equal(calls.some((call) => call.url === '/_kit/actions/transfer'), false);
  });

  it('перевод от обычной персоны идёт как раньше, клиент не создаётся', async () => {
    const facts = await run({ steps: [transfer(3_000_000)] });
    assert.equal(facts.client, null);
    assert.equal(calls.some((call) => call.url === '/_kit/actions/check-client'), false);
  });

  it('часы синхронизируются только при смене времени банка', async () => {
    await run({
      steps: [
        { scenario: { bankTime: 'noon' } },
        { scenario: { bankTime: 'noon', sbpMode: 'REJECT' } },
        { scenario: { bankTime: null } },
      ],
    });
    const times = calls.filter((call) => call.url === '/_kit/scenario').map((call) => call.body?.bankTime);
    assert.match(String(times[0]), /^\d{4}-\d{2}-\d{2}T12:00$/);
    assert.equal(times[1], times[0]);
    assert.equal(times[2], null);
  });
});
