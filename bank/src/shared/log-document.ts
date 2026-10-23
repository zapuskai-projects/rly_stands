import type { LogEntry } from './logger';

export interface LogContext {
  label: string | null;
  bankTime: Date | null;
}

export interface LogDocument {
  '@timestamp': string;
  level: string;
  role: string;
  service: string;
  message: string;
  bankTime?: string;
  label?: string;
  operationId?: string;
  operationNumber?: string;
  requestId?: string;
  status?: string;
  previousStatus?: string;
  reasonCode?: string;
  errorCode?: string;
  httpStatus?: number;
  method?: string;
  path?: string;
  durationMs?: number;
  error?: string;
  details?: string;
}

const STRING_FIELDS = ['label', 'operationId', 'operationNumber', 'requestId', 'previousStatus', 'reasonCode', 'method', 'path', 'error', 'bankTime'] as const;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;
const INDEX_PREFIX = 'bank-logs-';

export function logIndexName(isoTimestamp: string): string {
  const day = DAY_PATTERN.exec(isoTimestamp);
  return `${INDEX_PREFIX}${day ? `${day[1]}.${day[2]}.${day[3]}` : 'unknown'}`;
}

function stringify(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item));
}

export function toLogDocument(entry: LogEntry, context: LogContext): LogDocument {
  const rest: Record<string, unknown> = { ...entry.fields };
  const take = (name: string): unknown => {
    const value = rest[name];
    delete rest[name];
    return value;
  };
  const document: LogDocument = {
    '@timestamp': entry.ts,
    level: entry.level,
    role: entry.service.replace(/^bank-/, ''),
    service: entry.service,
    message: entry.message,
  };
  if (context.label !== null) document.label = context.label;
  for (const name of STRING_FIELDS) {
    const value = rest[name];
    if (typeof value === 'string') {
      document[name] = value;
      delete rest[name];
    }
  }
  if (document.bankTime === undefined && context.bankTime) document.bankTime = context.bankTime.toISOString();
  const status = take('status');
  if (typeof status === 'string') document.status = status;
  else if (typeof status === 'number') document.httpStatus = status;
  else if (status !== undefined) rest.status = status;
  const code = take('code') ?? take('errorCode');
  if (typeof code === 'string') document.errorCode = code;
  const duration = rest.durationMs;
  if (typeof duration === 'number') {
    document.durationMs = duration;
    delete rest.durationMs;
  }
  for (const key of Object.keys(rest)) if (rest[key] === undefined) delete rest[key];
  if (Object.keys(rest).length > 0) document.details = stringify(rest);
  return document;
}

export const LOG_INDEX_TEMPLATE = {
  index_patterns: [`${INDEX_PREFIX}*`],
  template: {
    settings: { number_of_shards: 1, number_of_replicas: 0 },
    mappings: {
      properties: {
        '@timestamp': { type: 'date' },
        bankTime: { type: 'date' },
        level: { type: 'keyword' },
        role: { type: 'keyword' },
        service: { type: 'keyword' },
        message: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 256 } } },
        label: { type: 'keyword' },
        operationId: { type: 'keyword' },
        operationNumber: { type: 'keyword' },
        requestId: { type: 'keyword' },
        status: { type: 'keyword' },
        previousStatus: { type: 'keyword' },
        reasonCode: { type: 'keyword' },
        errorCode: { type: 'keyword' },
        httpStatus: { type: 'integer' },
        method: { type: 'keyword' },
        path: { type: 'keyword' },
        durationMs: { type: 'long' },
        error: { type: 'text' },
        details: { type: 'text' },
      },
    },
  },
};
