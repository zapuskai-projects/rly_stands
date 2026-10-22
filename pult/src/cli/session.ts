import { password } from '@inquirer/prompts';
import type { Runtime } from '../config';
import { fetchSession } from '../platform/client';
import { supportedPrimitives } from '../platform/primitives';
import type { Session } from '../platform/types';
import { readConfig, writeConfig } from '../store/stores';
import { errorLine, line } from '../util/out';
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

export async function login(runtime: Runtime): Promise<SessionContext | null> {
  const token = await readToken();
  if (!token) {
    errorLine('Токен не введён.');
    return null;
  }
  const result = await fetchSession(runtime.platformUrl, token, runtime.version, await supportedPrimitives());
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
    line('Первый запуск: вставьте токен, который выдала платформа.');
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
    line('Вставьте новый токен.');
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
