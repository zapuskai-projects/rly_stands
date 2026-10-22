import { ProbeError, errorCode, errorText } from './errors';

export type HttpOptions = {
  method?: string;
  json?: unknown;
  body?: string | FormData;
  headers?: Record<string, string>;
  basic?: string;
  timeoutMs?: number;
};

export type HttpResult = {
  status: number;
  ok: boolean;
  text: string;
  json: unknown;
  headers: Record<string, string>;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const RESET_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE']);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function http(module: string, url: string, options: HttpOptions = {}): Promise<HttpResult> {
  try {
    return await send(url, options);
  } catch (first) {
    const code = errorCode(first);
    if (!code || !RESET_CODES.has(code)) throw new ProbeError(`${module} не отвечает: ${errorText(first)}`);
    try {
      return await send(url, options);
    } catch (second) {
      throw new ProbeError(`${module} не отвечает: ${errorText(second)}`);
    }
  }
}

async function send(url: string, options: HttpOptions): Promise<HttpResult> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.basic) headers.Authorization = `Basic ${Buffer.from(options.basic).toString('base64')}`;
  let body: string | FormData | undefined = options.body;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }
  const response = await fetch(url, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    text,
    json: parseJson(text),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function failure(module: string, action: string, result: HttpResult): ProbeError {
  const detail = result.text.slice(0, 300).trim();
  return new ProbeError(`${module}: ${action} — код ${result.status}${detail ? `, ${detail}` : ''}`);
}
