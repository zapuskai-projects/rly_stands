import { sessionAfterLogin, waitForApproval } from '../actions/device';
export { sessionAfterLogin, waitForApproval, type WaitOutcome } from '../actions/device';
import { password } from '@inquirer/prompts';
import type { Runtime } from '../config';
import { fetchSession } from '../platform/client';
import {
  deviceLoginStatus,
  generateKitToken,
  startDeviceLogin,
  tokenFingerprint,
} from '../platform/device';
import { supportedPrimitives } from '../platform/primitives';
import { type SessionContext } from '../actions/session';
import { routeLogin } from '../panel/gateway';
export type { SessionContext } from '../actions/session';
import { requestOpen } from '../util/open-url';
import { color, errorLine, line } from '../util/out';
import { formatShortDate } from './format';
import { dispatchAction } from '../actions/dispatcher';
import { consoleProgress } from './progress';

async function readToken(): Promise<string> {
  if (process.stdin.isTTY) {
    return (await password({ message: 'Токен с платформы', mask: '*' })).trim();
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]?.trim() ?? '';
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

export async function login(runtime: Runtime, options: LoginOptions = {}): Promise<SessionContext | null> {
  const token = options.paste ? await readToken() : await deviceToken(runtime);
  if (!token) {
    if (options.paste) errorLine('Токен не введён.');
    return null;
  }
  const primitives = await supportedPrimitives();
  const result = await sessionAfterLogin(() => fetchSession(runtime.platformUrl, token, runtime.version, primitives));
  if (!result.ok && result.kind === 'unreachable' && !options.paste) {
    await routeLogin(runtime, token, null);
    errorLine(`${result.message}. Пульт подключён — запустите ./stand ещё раз, когда платформа ответит.`);
    return null;
  }
  if (!result.ok) {
    errorLine(result.message);
    return null;
  }
  await routeLogin(runtime, token, result.session);
  line(
    `Здравствуйте, ${result.session.user.name}. Токен действует до ${formatShortDate(result.session.token.expiresAt)}.`,
  );
  return { session: result.session, stale: false, staleSince: null };
}

export async function loadSession(
  runtime: Runtime,
  interactive: boolean,
): Promise<SessionContext | null> {
  const refreshed = await dispatchAction({ runtime, progress: consoleProgress }, { action: 'platform.refresh' });
  const context = refreshed.sessionContext;
  if (context) {
    if (context.stale && refreshed.message) errorLine(`${refreshed.message}. Показываю данные от ${formatShortDate(context.staleSince!, true)}.`);
    return context;
  }
  if (refreshed.message) errorLine(refreshed.message);
  if (!interactive || ['ACTION_FAILED', 'PLATFORM_UNREACHABLE'].includes(refreshed.code ?? '')) return null;
  line('Подключите пульт к своему аккаунту.');
  return login(runtime);
}
