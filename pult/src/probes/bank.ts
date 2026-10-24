import {
  accepted,
  assertSecretAccepted,
  BANK_MODULE as MODULE,
  call,
  fetchOperation,
  hasFunding,
  query,
  resolveBankTime,
  resolvePersonaTimes,
} from './bank-api';
import { ProbeError } from './errors';
import { asArray, asRecord, failure, num, str } from './http';
import { executor, type ExecutorTable } from './types';

export function operationFacts(body: Record<string, unknown>) {
  return {
    exists: true,
    ageSeconds: 0,
    hasKopecks: false,
    ...body,
    statusHistory: asArray(body.statusHistory),
    defects: asArray(body.defects),
    postings: asArray(body.postings),
    notifications: asArray(body.notifications),
    antifraud: body.antifraud ?? null,
  };
}

export function operationTotals(operations: unknown[]): { totalKop: number; transitionsCount: number } {
  let totalKop = 0;
  let transitionsCount = 0;
  for (const operation of operations) {
    const row = asRecord(operation);
    totalKop += num(row.amountKop);
    transitionsCount += Math.max(0, asArray(row.statusHistory).length - 1);
  }
  return { totalKop, transitionsCount };
}

export function duplicateKeys(requests: unknown[]): Array<{ key: string; count: number; operations: number }> {
  const counts = new Map<string, { count: number; operations: Set<string> }>();
  for (const request of requests) {
    const row = asRecord(request);
    const key = row.idempotencyKey;
    if (typeof key !== 'string' || !key) continue;
    const entry = counts.get(key) ?? { count: 0, operations: new Set<string>() };
    entry.count += 1;
    const operationId = str(row.operationId);
    if (operationId) entry.operations.add(operationId);
    counts.set(key, entry);
  }
  return [...counts]
    .filter(([, entry]) => entry.count >= 2)
    .map(([key, entry]) => ({ key, count: entry.count, operations: entry.operations.size }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

const POLL_PATH = /^\/api\/v1\/operations\/[^/]+$/;

export type PollSummary = {
  operationId: string;
  polls: number;
  pollsAfterTerminal: number;
  firstPollAt: string;
  lastPollAt: string;
  terminalAt: string | null;
};

export function pollSummaries(requests: unknown[]): PollSummary[] {
  const byOperation = new Map<string, Array<{ at: string; terminalAt: string | null }>>();
  for (const request of requests) {
    const row = asRecord(request);
    const operationId = str(row.operationId);
    if (row.method !== 'GET' || !operationId || !POLL_PATH.test(str(row.path))) continue;
    const list = byOperation.get(operationId) ?? [];
    list.push({ at: str(row.at), terminalAt: typeof row.operationTerminalAt === 'string' ? row.operationTerminalAt : null });
    byOperation.set(operationId, list);
  }
  return [...byOperation].map(([operationId, polls]) => {
    const times = polls.map((poll) => poll.at).sort((a, b) => Date.parse(a) - Date.parse(b));
    const terminalAt = polls.find((poll) => poll.terminalAt)?.terminalAt ?? null;
    return {
      operationId,
      polls: polls.length,
      pollsAfterTerminal: terminalAt ? polls.filter((poll) => Date.parse(poll.at) > Date.parse(terminalAt)).length : 0,
      firstPollAt: times[0] ?? '',
      lastPollAt: times.at(-1) ?? '',
      terminalAt,
    };
  });
}

export function pollFacts(requests: unknown[]) {
  const polls = pollSummaries(requests);
  return {
    polls,
    maxPolls: Math.max(0, ...polls.map((item) => item.polls)),
    maxPollsAfterTerminal: Math.max(0, ...polls.map((item) => item.pollsAfterTerminal)),
    polledTerminalCount: polls.filter((item) => item.terminalAt !== null).length,
  };
}

export const BANK_EXECUTORS: ExecutorTable = {
  'bank.operations': executor<{ label?: string; phone?: string; status?: string }>(async (params, ctx) => {
    const result = await call(ctx, 'GET', `/facts/operations${query(params)}`);
    if (!result.ok) throw failure(MODULE, 'чтение операций', result);
    const body = result.json;
    const operations = Array.isArray(body) ? body : asArray(asRecord(body).operations);
    return { count: operations.length, ...operationTotals(operations), operations };
  }),

  'bank.operation': executor<{ id: string }>(async ({ id }, ctx) => {
    const body = await fetchOperation(ctx, id);
    if (!body) {
      return {
        exists: false,
        ageSeconds: 0,
        hasKopecks: false,
        statusHistory: [],
        defects: [],
        postings: [],
        notifications: [],
        antifraud: null,
      };
    }
    return operationFacts(body);
  }),

  'bank.ledger': executor<{ account?: string }>(async ({ account }, ctx) => {
    const result = await call(ctx, 'GET', `/facts/ledger${query({ account })}`);
    if (!result.ok) throw failure(MODULE, 'чтение главной книги', result);
    const body = asRecord(result.json);
    return { inconsistent: [], ...body };
  }),

  'bank.notifications': executor<{ operationId: string }>(async ({ operationId }, ctx) => {
    const body = await fetchOperation(ctx, operationId);
    const notifications = body ? asArray(body.notifications) : [];
    return {
      exists: body !== null,
      count: notifications.length,
      anyBeforeCompletion: notifications.some((item) => asRecord(item).beforeCompletion === true),
      notifications,
    };
  }),

  'bank.antifraud': executor<{ operationId: string }>(async ({ operationId }, ctx) => {
    const body = await fetchOperation(ctx, operationId);
    const antifraud = body ? asRecord(body.antifraud) : {};
    if (!body || !Object.keys(antifraud).length) return { exists: false, rules: [] };
    return { exists: true, rules: [], ...antifraud };
  }),

  'bank.requestLog': executor<{ label: string }>(async ({ label }, ctx) => {
    const result = await call(ctx, 'GET', `/facts/requests${query({ label })}`);
    if (!result.ok) throw failure(MODULE, 'чтение журнала запросов', result);
    const body = result.json;
    const requests = Array.isArray(body) ? body : asArray(asRecord(body).requests);
    return { count: requests.length, requests, duplicateKeys: duplicateKeys(requests), ...pollFacts(requests) };
  }),

  'bank.tariff': executor<{ code: string }>(async ({ code }, ctx) => {
    const result = await call(ctx, 'GET', `/facts/tariffs/${encodeURIComponent(code)}`);
    if (result.status === 404) {
      await assertSecretAccepted(ctx);
      return { exists: false, code };
    }
    if (!result.ok) throw failure(MODULE, 'чтение тарифа', result);
    return { exists: true, ...asRecord(result.json) };
  }),

  'bank.scenario': executor<{
    reset?: boolean;
    defects?: string[];
    sbpMode?: string;
    bankTime?: string | null;
    tariffs?: unknown[];
    personas?: unknown[];
  }>(async (params, ctx) => {
    if (!params.reset && hasFunding(params.personas)) {
      throw new ProbeError('topUpKop и history не повторяются безопасно: используйте их только с reset: true');
    }
    if (params.reset) await accepted(ctx, '/reset', {}, 'сброс банка');
    await accepted(
      ctx,
      '/scenario',
      {
        label: ctx.label,
        defects: params.defects ?? [],
        sbpMode: params.sbpMode ?? 'NORMAL',
        bankTime: resolveBankTime(params.bankTime),
        ...(params.tariffs ? { tariffs: params.tariffs } : {}),
        ...(params.personas ? { personas: resolvePersonaTimes(params.personas) } : {}),
      },
      'включение сценария',
    );
    return { applied: true };
  }),

  'bank.transfer': executor<Record<string, unknown>>(async (params, ctx) => {
    const body = await accepted(ctx, '/actions/transfer', { ...params, label: ctx.label }, 'перевод');
    return {
      operationId: str(body.operationId),
      number: str(body.number),
      status: str(body.status),
      amountKop: num(params.amountKop),
    };
  }),

  'bank.ledgerScan': executor<Record<string, never>>(async (_params, ctx) => {
    const result = await call(ctx, 'GET', '/facts/ledger');
    if (!result.ok) throw failure(MODULE, 'чтение главной книги', result);
    const inconsistent = asArray(asRecord(result.json).inconsistent).map(asRecord);
    const first = inconsistent[0];
    return {
      count: inconsistent.length,
      account: str(first?.account),
      balanceKop: num(first?.balanceKop),
      postingsSumKop: num(first?.postingsSumKop),
    };
  }),

  'bank.setTariff': executor<Record<string, unknown>>(async (params, ctx) => {
    await accepted(ctx, '/actions/set-tariff', params, 'изменение тарифа');
    return { updated: true };
  }),

  'bank.review': executor<{ operationId: string; decision: string; comment?: string }>(async (params, ctx) => {
    await accepted(ctx, '/actions/review', params, 'решение оператора');
    return { reviewed: true };
  }),
};
