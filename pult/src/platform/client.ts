import { describeNetworkError } from './network-error';
import type {
  AttemptProbes,
  CheckOutcome,
  PlatformCall,
  Session,
  SessionResult,
  TaskDefinition,
} from './types';

const REQUEST_TIMEOUT_MS = 10_000;
const REJECTED_FALLBACK = 'Токен истёк или отозван — получите новый на платформе';

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return Array.isArray(row.modules) && typeof row.kit === 'object' && typeof row.user === 'object';
}

async function rejectionMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : REJECTED_FALLBACK;
  } catch {
    return REJECTED_FALLBACK;
  }
}

export async function fetchSession(
  platformUrl: string,
  token: string,
  kitVersion: string,
  primitives: string[] = [],
): Promise<SessionResult> {
  try {
    const response = await fetch(`${platformUrl}/api/stand-kit/session`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Kit-Version': kitVersion,
        'X-Kit-Primitives': primitives.join(','),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) {
      return { ok: false, kind: 'rejected', message: await rejectionMessage(response) };
    }
    if (!response.ok) {
      return { ok: false, kind: 'unreachable', message: `Платформа ответила ${response.status}` };
    }
    const body: unknown = await response.json();
    if (!isSession(body)) {
      return { ok: false, kind: 'unreachable', message: 'Платформа вернула неожиданный ответ' };
    }
    return { ok: true, session: body };
  } catch (error) {
    return { ok: false, kind: 'unreachable', message: `Платформа недоступна: ${describeNetworkError(error, platformUrl)}` };
  }
}

export type PingResult = { ok: true } | { ok: false; reason: string };

export async function pingPlatform(platformUrl: string): Promise<PingResult> {
  try {
    const response = await fetch(`${platformUrl}/health`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return response.ok ? { ok: true } : { ok: false, reason: `ответила ${response.status}` };
  } catch (error) {
    return { ok: false, reason: describeNetworkError(error, platformUrl) };
  }
}

export type PlatformAuth = { platformUrl: string; token: string; kitVersion: string };

const CALL_TIMEOUT_MS = 60_000;
const CHECK_TIMEOUT_MS = 300_000;

function messageOf(body: unknown, fallback: string): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return typeof message === 'string' ? message : fallback;
}

async function call<T>(
  auth: PlatformAuth,
  path: string,
  init: { method: 'GET' | 'POST' | 'PUT'; body?: unknown; primitives?: string[]; timeoutMs?: number },
): Promise<PlatformCall<T>> {
  try {
    const response = await fetch(`${auth.platformUrl}/api/stand-kit${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'X-Kit-Version': auth.kitVersion,
        'X-Kit-Primitives': (init.primitives ?? []).join(','),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? CALL_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, status: response.status, message: messageOf(body, `Платформа ответила ${response.status}`) };
    }
    return { ok: true, value: body as T };
  } catch (error) {
    if (init.timeoutMs === CHECK_TIMEOUT_MS && error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      return { ok: false, status: 0, message: 'Проверка не ответила за отведённое время. Результат может появиться позже — откройте задачу на платформе.' };
    }
    return { ok: false, status: 0, message: `Платформа недоступна: ${describeNetworkError(error, auth.platformUrl)}` };
  }
}

export function startTask(auth: PlatformAuth, labId: string, primitives: string[]) {
  return call<TaskDefinition>(auth, `/tasks/${encodeURIComponent(labId)}/start`, { method: 'POST', primitives });
}

export function checkAttempt(auth: PlatformAuth, attemptId: string, observations: Record<string, unknown>) {
  return call<CheckOutcome>(auth, `/attempts/${encodeURIComponent(attemptId)}/check`, {
    method: 'POST',
    body: { observations },
    timeoutMs: CHECK_TIMEOUT_MS,
  });
}

export function fetchAttemptProbes(auth: PlatformAuth, attemptId: string) {
  return call<AttemptProbes>(auth, `/attempts/${encodeURIComponent(attemptId)}/probes`, { method: 'GET' });
}

export function putAttemptReport(auth: PlatformAuth, attemptId: string, report: Record<string, string>) {
  return call<{ report: Record<string, string> }>(auth, `/attempts/${encodeURIComponent(attemptId)}/report`, {
    method: 'PUT',
    body: { report },
  });
}

export async function fetchPrimitiveKeys(auth: PlatformAuth): Promise<PlatformCall<string[]>> {
  const result = await call<{ primitives: Array<{ key: string; server?: boolean }> }>(auth, '/primitives', {
    method: 'GET',
  });
  if (!result.ok) return result;
  return { ok: true, value: result.value.primitives.filter((item) => !item.server).map((item) => item.key) };
}
