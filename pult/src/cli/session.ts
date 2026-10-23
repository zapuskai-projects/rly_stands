import { password } from '@inquirer/prompts';
import type { Runtime } from '../config';
import { fetchSession } from '../platform/client';
import {
  deviceLoginStatus,
  generateKitToken,
  startDeviceLogin,
  tokenFingerprint,
  type DeviceCall,
  type DeviceLoginStatus,
} from '../platform/device';
import { supportedPrimitives } from '../platform/primitives';
import type { Session, SessionResult } from '../platform/types';
import { readConfig, writeConfig } from '../store/stores';
import { requestOpen } from '../util/open-url';
import { color, errorLine, line } from '../util/out';
import { formatShortDate } from './format';

export type SessionContext = {
  session: Session;
  stale: boolean;
  staleSince: string | null;
};

async function readToken(): Promise<string> {
  if (process.stdin.isTTY) {
    return (await password({ message: 'Токен с платформы', mask: '*' })).trim();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]?.trim() ?? '';
}

export type WaitOutcome = 'APPROVED' | 'DENIED' | 'EXPIRED' | { error: string };

type WaitOptions = {
  intervalMs: number;
  deadline: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (message: string) => void;
};

/** Ждёт, пока человек подтвердит код на сайте: сбои сети переживает до конца срока кода. */
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

async function deviceToken(runtime: Runtime): Promise<string | null> {
  const token = generateKitToken();
  const started = await startDeviceLogin(runtime.platformUrl, tokenFingerprint(token), runtime.version);
  if (!started.ok) {
    errorLine(started.message);
    return null;
  }
  const { id, code, verifyUrl, expiresAt, intervalSec } = started.value;
  line('Подключите пульт к своему аккаунту на платформе.');
  line(verifyUrl ? `  Откройте: ${color.bold(verifyUrl)}` : '  Откройте на сайте платформы страницу «Подключить пульт»: /kit/connect');
  line(`  Код: ${color.bold(code)} — сверьте его на странице и нажмите «Подключить».`);
  line(color.dim('  Код действует 10 минут. Вставить токен вручную: ./stand login --token'));
  if (verifyUrl && requestOpen(runtime, verifyUrl)) line(color.dim('  Страница откроется в браузере.'));
  const outcome = await waitForApproval(() => deviceLoginStatus(runtime.platformUrl, id), {
    intervalMs: Math.max(1, intervalSec) * 1000,
    deadline: Date.parse(expiresAt),
    onRetry: (message) => errorLine(`${message}. Жду связи…`),
  });
  if (outcome === 'APPROVED') return token;
  if (outcome === 'DENIED') errorLine('Вход отклонён на сайте. Если это были вы — запустите ./stand login ещё раз.');
  else if (outcome === 'EXPIRED') errorLine('Код устарел. Запустите ./stand login ещё раз.');
  else errorLine(outcome.error);
  return null;
}

export type LoginOptions = { paste?: boolean };

const SESSION_RETRIES = 3;

/** Сразу после входа платформа может мигнуть: пробуем ещё пару раз, прежде чем сдаться. */
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

export async function login(runtime: Runtime, options: LoginOptions = {}): Promise<SessionContext | null> {
  const token = options.paste ? await readToken() : await deviceToken(runtime);
  if (!token) {
    if (options.paste) errorLine('Токен не введён.');
    return null;
  }
  const primitives = await supportedPrimitives();
  const result = await sessionAfterLogin(() => fetchSession(runtime.platformUrl, token, runtime.version, primitives));
  if (!result.ok && result.kind === 'unreachable' && !options.paste) {
    // Вход уже подтверждён на сайте: токен сохраняем, иначе он потеряется, а на платформе останется.
    writeConfig(runtime.dataDir, { platformUrl: runtime.platformUrl, token, session: null, lastOkAt: null });
    errorLine(`${result.message}. Пульт подключён — запустите ./stand ещё раз, когда платформа ответит.`);
    return null;
  }
  if (!result.ok) {
    errorLine(result.message);
    return null;
  }
  writeConfig(runtime.dataDir, {
    platformUrl: runtime.platformUrl,
    token,
    session: result.session,
    lastOkAt: new Date().toISOString(),
  });
  line(
    `Здравствуйте, ${result.session.user.name}. Токен действует до ${formatShortDate(result.session.token.expiresAt)}.`,
  );
  return { session: result.session, stale: false, staleSince: null };
}

export async function loadSession(
  runtime: Runtime,
  interactive: boolean,
): Promise<SessionContext | null> {
  const config = readConfig(runtime.dataDir);
  if (!config.token) {
    if (!interactive) {
      errorLine('Токен не задан. Выполните: ./stand login');
      return null;
    }
    line('Первый запуск: подключаю пульт к вашему аккаунту.');
    return login(runtime);
  }
  const result = await fetchSession(
    config.platformUrl ?? runtime.platformUrl,
    config.token,
    runtime.version,
    await supportedPrimitives(),
  );
  if (result.ok) {
    writeConfig(runtime.dataDir, { session: result.session, lastOkAt: new Date().toISOString() });
    return { session: result.session, stale: false, staleSince: null };
  }
  if (result.kind === 'rejected') {
    writeConfig(runtime.dataDir, { token: null });
    errorLine(result.message);
    if (!interactive) return null;
    line('Подключите пульт заново.');
    return login(runtime);
  }
  const graceMs = (config.session?.kit.offlineGraceHours ?? 0) * 3600 * 1000;
  const since = config.lastOkAt ? Date.parse(config.lastOkAt) : null;
  if (config.session && since !== null && Date.now() - since <= graceMs) {
    errorLine(`${result.message}. Показываю данные от ${formatShortDate(config.lastOkAt!, true)}.`);
    return { session: config.session, stale: true, staleSince: config.lastOkAt };
  }
  errorLine(result.message);
  return null;
}
