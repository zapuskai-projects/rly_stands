import {
  accepted,
  assertSecretAccepted,
  BANK_MODULE as MODULE,
  BANK_RELEASES,
  call,
  fetchOperation,
  hasFunding,
  query,
  resolveBankTime,
  resolvePersonaTimes,
} from './bank-api';
import { ProbeError } from './errors';
import { deliveryRows, deliveryTotals, qrRows, qrTotals } from './bank-facts';
import { asArray, asRecord, failure, num, str } from './http';
export { deliveryRows, deliveryTotals, qrRows, qrTotals };
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

export function autopaymentTotals(templates: unknown[], autopayments: unknown[]) {
  const runs = autopayments.flatMap((item) => asArray(asRecord(item).runs).map(asRecord));
  const count = (outcome: string) => runs.filter((run) => run.outcome === outcome).length;
  return {
    count: autopayments.length,
    templatesCount: templates.length,
    runsCount: runs.length,
    executedRuns: count('EXECUTED'),
    failedRuns: count('FAILED'),
    pendingRuns: count('PENDING'),
  };
}

export function autopaymentRuns(autopayments: unknown[]) {
  return autopayments.flatMap((item) => {
    const owner = asRecord(item);
    return asArray(owner.runs).map((run) => {
      const row = asRecord(run);
      return {
        ...row,
        autopaymentId: str(owner.id),
        clientPhone: str(owner.clientPhone),
        defectCodes: asArray(row.defects).map((mark) => str(asRecord(mark).code)),
      };
    });
  });
}

const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;

export function requestRoute(path: string): string {
  return path.replace(UUID_SEGMENT, '/{id}');
}

export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function withRoutes(requests: unknown[]) {
  return requests.map((request) => {
    const row = asRecord(request);
    return { ...row, route: requestRoute(str(row.path)), statusClass: statusClass(num(row.status)) };
  });
}

export function withTemplateFlag(operations: unknown[]) {
  return operations.map((operation) => {
    const row = asRecord(operation);
    return { ...row, byTemplate: typeof row.templateId === 'string' && row.templateId !== '' };
  });
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

export function listFrom(body: unknown, key: string, what: string): unknown[] {
  if (Array.isArray(body)) return body;
  const list = asRecord(body)[key];
  if (!Array.isArray(list)) throw new ProbeError(`Банк вернул ${what} в неожиданной форме: нет списка ${key}`);
  return list;
}

export const BANK_EXECUTORS: ExecutorTable = {
  'bank.operations': executor<{ label?: string; phone?: string; status?: string }>(async (params, ctx) => {
    const result = await call(ctx, 'GET', `/facts/operations${query(params)}`);
    if (!result.ok) throw failure(MODULE, 'чтение операций', result);
    const body = result.json;
    const operations = withTemplateFlag(Array.isArray(body) ? body : asArray(asRecord(body).operations));
    return { count: operations.length, ...operationTotals(operations), operations };
  }),

  'bank.autopayments': executor<{ phone?: string; autopaymentId?: string }>(async (params, ctx) => {
    const result = await call(ctx, 'GET', `/facts/autopayments${query(params)}`);
    if (result.status === 404 && asRecord(result.json).code === 'AUTOPAYMENT_NOT_FOUND') {
      throw new ProbeError(`ЗапускБанк: автоплатёж ${params.autopaymentId ?? ''} не найден`);
    }
    if (result.status === 404) {
      await assertSecretAccepted(ctx);
      throw new ProbeError('Шаблоны и автоплатежи доступны с релиза 1.1: включите его сценарием банка (release: 1.1)');
    }
    if (!result.ok) throw failure(MODULE, 'чтение автоплатежей', result);
    const body = asRecord(result.json);
    const autopayments = asArray(body.autopayments);
    return { ...autopaymentTotals(asArray(body.templates), autopayments), templates: asArray(body.templates), autopayments, runs: autopaymentRuns(autopayments) };
  }),

  'bank.qrCodes': executor<{ label?: string; qrId?: string; orderId?: string }>(async (params, ctx) => {
    const result = await call(ctx, 'GET', `/facts/qr${query(params)}`);
    if (result.status === 404) {
      await assertSecretAccepted(ctx);
      throw new ProbeError('Оплата по QR доступна с релиза 1.2: включите его сценарием банка (release: 1.2)');
    }
    if (!result.ok) throw failure(MODULE, 'чтение QR-кодов', result);
    const qrCodes = qrRows(listFrom(result.json, 'qrCodes', 'QR-коды'));
    return { ...qrTotals(qrCodes), qrCodes };
  }),

  'bank.webhookDeliveries': executor<{ label?: string; qrId?: string; event?: string }>(async (params, ctx) => {
    const result = await call(ctx, 'GET', `/facts/webhook-deliveries${query(params)}`);
    if (result.status === 404) {
      await assertSecretAccepted(ctx);
      throw new ProbeError('Уведомления магазину доступны с релиза 1.2: включите его сценарием банка (release: 1.2)');
    }
    if (!result.ok) throw failure(MODULE, 'чтение журнала доставок', result);
    const deliveries = deliveryRows(listFrom(result.json, 'deliveries', 'журнал доставок'));
    return { ...deliveryTotals(deliveries), deliveries };
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
    if (!account && !Array.isArray(body.inconsistent)) throw new ProbeError('Банк вернул главную книгу в неожиданной форме: нет списка inconsistent');
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
    return { count: requests.length, requests: withRoutes(requests), duplicateKeys: duplicateKeys(requests), ...pollFacts(requests) };
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
    release?: string;
    bankTime?: string | null;
    tariffs?: unknown[];
    personas?: unknown[];
  }>(async (params, ctx) => {
    if (!params.reset && hasFunding(params.personas)) {
      throw new ProbeError('topUpKop и history не повторяются безопасно: используйте их только с reset: true');
    }
    if (params.release !== undefined && !BANK_RELEASES.includes(params.release)) {
      throw new ProbeError(`Релиз банка ${params.release} неизвестен: допустимы ${BANK_RELEASES.join(', ')}`);
    }
    if (params.reset) await accepted(ctx, '/reset', {}, 'сброс банка');
    await accepted(
      ctx,
      '/scenario',
      {
        label: ctx.label,
        defects: params.defects ?? [],
        sbpMode: params.sbpMode ?? 'NORMAL',
        ...(params.release === undefined ? {} : { release: params.release }),
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

  'bank.autopayRun': executor<{ autopaymentId: string }>(async ({ autopaymentId }, ctx) => {
    const body = await accepted(ctx, '/actions/autopay-run', { autopaymentId, label: ctx.label }, 'ручной запуск автоплатежа');
    return {
      runId: str(body.runId),
      attempt: num(body.attempt),
      outcome: str(body.outcome),
      operationId: str(body.operationId),
      reasonCode: str(body.reasonCode),
      autopaymentStatus: str(body.autopaymentStatus),
      nextRunOn: str(body.nextRunOn),
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
