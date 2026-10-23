import { LOG_INDEX_TEMPLATE, logIndexName, toLogDocument, type LogContext } from './log-document';
import { localLogger, setLogSink, type LogEntry } from './logger';

const FLUSH_INTERVAL_MS = 2000;
const BATCH_SIZE = 500;
const BATCHES_PER_FLUSH = 5;
const MAX_QUEUE = 5000;
const MAX_BACKOFF_MS = 30_000;
const REPORT_EVERY_MS = 300_000;
const REQUEST_TIMEOUT_MS = 5000;

interface Queued {
  index: string;
  body: string;
}

export interface ShipperOptions {
  url: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  intervalMs?: number;
  context?: () => LogContext;
}

export function bulkPayload(items: readonly Queued[]): string {
  return `${items.flatMap((item) => [JSON.stringify({ index: { _index: item.index } }), item.body]).join('\n')}\n`;
}

export function bulkFailures(result: unknown): { failed: number; reason: string } {
  const items = (result as { items?: unknown }).items;
  if (!Array.isArray(items)) return { failed: 0, reason: '' };
  let failed = 0;
  let reason = '';
  for (const item of items as Array<Record<string, { error?: { type?: string; reason?: string } }>>) {
    const error = Object.values(item)[0]?.error;
    if (!error) continue;
    failed += 1;
    if (!reason) reason = `${error.type ?? 'error'}: ${error.reason ?? ''}`;
  }
  return { failed, reason };
}

export class LogShipper {
  private queue: Queued[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;
  private templateReady = false;
  private failures = 0;
  private nextAttemptAt = 0;
  private lastReportAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;
  private dropped = 0;
  private broken = false;
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private context: () => LogContext;

  constructor(options: ShipperOptions) {
    this.url = options.url.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? FLUSH_INTERVAL_MS;
    this.context = options.context ?? (() => ({ label: null, bankTime: null }));
  }

  setContext(context: () => LogContext): void {
    this.context = context;
  }

  push(entry: LogEntry): void {
    this.queue.push({ index: logIndexName(entry.ts), body: JSON.stringify(toLogDocument(entry, this.context())) });
    if (this.queue.length > MAX_QUEUE) {
      const overflow = this.queue.length - MAX_QUEUE;
      this.queue.splice(0, overflow);
      this.dropped += overflow;
    }
  }

  pending(): number {
    return this.queue.length;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextAttemptAt = 0;
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0 || this.now() < this.nextAttemptAt) return;
    this.flushing = true;
    try {
      if (!this.templateReady) await this.ensureTemplate();
      for (let round = 0; round < BATCHES_PER_FLUSH && this.queue.length > 0; round += 1) {
        const batch = this.queue.slice(0, BATCH_SIZE);
        await this.send(batch);
        const sent = new Set<Queued>(batch);
        this.queue = this.queue.filter((item) => !sent.has(item));
      }
      this.succeeded();
    } catch (error) {
      this.failed(error instanceof Error ? error.message : String(error));
    } finally {
      this.flushing = false;
    }
  }

  private async ensureTemplate(): Promise<void> {
    const response = await this.fetchImpl(`${this.url}/_index_template/bank-logs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(LOG_INDEX_TEMPLATE),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    this.templateReady = true;
    if (!response.ok) this.report(`Elasticsearch не принял шаблон индекса журнала банка: HTTP ${response.status}`);
  }

  private async send(batch: readonly Queued[]): Promise<void> {
    const response = await this.fetchImpl(`${this.url}/_bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: bulkPayload(batch),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Elasticsearch ответил HTTP ${response.status}`);
    const failures = bulkFailures(await response.json());
    if (failures.failed > 0) this.report(`Elasticsearch отклонил ${failures.failed} из ${batch.length} записей журнала банка (${failures.reason})`);
  }

  private succeeded(): void {
    this.failures = 0;
    this.nextAttemptAt = 0;
    if (this.dropped > 0) this.report(`Журнал банка не успевал уходить в Elasticsearch: потеряно записей ${this.dropped}`);
    this.dropped = 0;
    if (this.broken) {
      this.broken = false;
      localLogger.info('log shipping to elasticsearch restored');
    }
  }

  private failed(reason: string): void {
    this.failures += 1;
    this.nextAttemptAt = this.now() + Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** this.failures);
    this.broken = true;
    this.report(`Журнал банка не уходит в Elasticsearch (${reason}): записи ждут в очереди, банк работает как обычно`);
  }

  private report(message: string): void {
    const at = this.now();
    if (at - this.lastReportAt < REPORT_EVERY_MS) {
      this.suppressed += 1;
      return;
    }
    this.lastReportAt = at;
    localLogger.warn(message, this.suppressed > 0 ? { suppressed: this.suppressed } : {});
    this.suppressed = 0;
  }
}

let active: LogShipper | null = null;
const CONTEXT_REFRESH_MS = 2000;

export function startLogShipping(url: string | null): LogShipper | null {
  if (!url) return null;
  active = new LogShipper({ url });
  setLogSink((entry) => active?.push(entry));
  active.start();
  return active;
}

export function getLogShipper(): LogShipper | null {
  return active;
}

export interface LogContextSources {
  label: () => Promise<string | null>;
  clock?: { now(): Date };
}

export function skipWhileRunning(task: () => Promise<void>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    void task().finally(() => {
      running = false;
    });
  };
}

export function bindLogContext(sources: LogContextSources): void {
  if (!active) return;
  let label: string | null = null;
  const refresh = skipWhileRunning(async () => {
    label = await sources.label().catch(() => label);
  });
  refresh();
  setInterval(refresh, CONTEXT_REFRESH_MS).unref();
  active.setContext(() => ({ label, bankTime: sources.clock?.now() ?? null }));
}
