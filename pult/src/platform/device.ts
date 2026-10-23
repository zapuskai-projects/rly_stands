import { createHash, randomBytes } from 'node:crypto';
import { describeNetworkError } from './network-error';

export type DeviceLoginStart = {
  id: string;
  code: string;
  verifyUrl: string | null;
  expiresAt: string;
  intervalSec: number;
};

export type DeviceLoginStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';

export type DeviceCall<T> = { ok: true; value: T } | { ok: false; message: string; retry: boolean };

const TIMEOUT_MS = 10_000;

/** Токен того же вида, что выдаёт платформа: пульт создаёт его сам и отдаёт только отпечаток. */
export function generateKitToken(): string {
  return `sk_${randomBytes(32).toString('base64url')}`;
}

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function messageOf(body: unknown, fallback: string): string {
  const message = (body as { message?: unknown } | null)?.message;
  if (Array.isArray(message)) return message.map(String).join('; ');
  return typeof message === 'string' ? message : fallback;
}

async function request<T>(platformUrl: string, path: string, init: RequestInit): Promise<DeviceCall<T>> {
  try {
    const response = await fetch(`${platformUrl}/api/stand-kit/device${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        message: messageOf(body, `Платформа ответила ${response.status}`),
        retry: response.status >= 500,
      };
    }
    return { ok: true, value: body as T };
  } catch (error) {
    return { ok: false, message: `Платформа недоступна: ${describeNetworkError(error, platformUrl)}`, retry: true };
  }
}

export function startDeviceLogin(platformUrl: string, tokenHash: string, kitVersion: string) {
  return request<DeviceLoginStart>(platformUrl, '', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokenHash, kitVersion }),
  });
}

export async function deviceLoginStatus(platformUrl: string, id: string): Promise<DeviceCall<DeviceLoginStatus>> {
  const result = await request<{ status: DeviceLoginStatus }>(platformUrl, `/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  return result.ok ? { ok: true, value: result.value.status } : result;
}
