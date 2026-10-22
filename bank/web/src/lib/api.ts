import { noteBankTime } from './bank-time';

export type Realm = 'client' | 'office';

export interface FieldIssue {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: FieldIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TOKEN_KEYS: Record<Realm, string> = { client: 'bank.token', office: 'office.token' };

let unauthorizedHandler: ((realm: Realm) => void) | null = null;

export function onUnauthorized(handler: (realm: Realm) => void): void {
  unauthorizedHandler = handler;
}

export function getToken(realm: Realm): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEYS[realm]);
  } catch {
    return null;
  }
}

export function setToken(realm: Realm, token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEYS[realm], token);
    else window.localStorage.removeItem(TOKEN_KEYS[realm]);
  } catch {
    return;
  }
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  anonymous?: boolean;
}

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

export async function request<T>(realm: Realm, method: string, path: string, options: RequestOptions = {}, headers: Record<string, string> = {}): Promise<T> {
  const token = options.anonymous ? null : getToken(realm);
  const response = await fetch(withQuery(path, options.query), {
    method,
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  noteBankTime(response.headers.get('x-bank-time'));
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = (payload ?? {}) as { code?: string; message?: string; details?: FieldIssue[] };
    if (response.status === 401 && !options.anonymous) {
      setToken(realm, null);
      unauthorizedHandler?.(realm);
    }
    throw new ApiError(response.status, error.code ?? 'ERROR', error.message ?? 'Не удалось выполнить запрос', error.details ?? []);
  }
  return payload as T;
}

export const clientApi = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>('client', 'GET', path, { query }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) => request<T>('client', 'POST', path, { body }, headers),
  anonymous: <T>(method: string, path: string, options: Omit<RequestOptions, 'anonymous'> = {}) => request<T>('client', method, path, { ...options, anonymous: true }),
};

export const officeApi = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>('office', 'GET', path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>('office', 'POST', path, { body }),
  put: <T>(path: string, body: unknown) => request<T>('office', 'PUT', path, { body }),
  anonymous: <T>(method: string, path: string, options: Omit<RequestOptions, 'anonymous'> = {}) => request<T>('office', method, path, { ...options, anonymous: true }),
};

export function explain(error: unknown): string {
  if (error instanceof ApiError) {
    const first = error.details[0];
    return first ? `${error.message}: ${first.message}` : error.message;
  }
  return 'Нет связи с банком. Попробуйте ещё раз';
}

export function newKey(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}
