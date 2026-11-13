import type { DeviceCall, DeviceLoginStatus } from '../platform/device';
import type { SessionResult } from '../platform/types';

export type WaitOutcome = 'APPROVED' | 'DENIED' | 'EXPIRED' | { error: string };

type WaitOptions = {
  intervalMs: number;
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (message: string) => void;
};

export async function waitForApproval(
  poll: () => Promise<DeviceCall<DeviceLoginStatus>>,
  options: WaitOptions,
): Promise<WaitOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let warned = false;
  while (now() < options.deadline) {
    await sleep(options.intervalMs);
    const status = await poll();
    if (!status.ok) {
      if (!status.retry) return { error: status.message };
      if (!warned) options.onRetry?.(status.message);
      warned = true;
      continue;
    }
    if (status.value !== 'PENDING') return status.value;
  }
  return 'EXPIRED';
}

const SESSION_RETRIES = 3;

export async function sessionAfterLogin(
  fetch: () => Promise<SessionResult>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<SessionResult> {
  let result = await fetch();
  for (let attempt = 1; attempt < SESSION_RETRIES && !result.ok && result.kind === 'unreachable'; attempt += 1) {
    await sleep(3000);
    result = await fetch();
  }
  return result;
}

