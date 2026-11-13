import type { Runtime } from '../config';
import { fetchSession } from '../platform/client';
import { supportedPrimitives } from '../platform/primitives';
import type { Session, SessionResult } from '../platform/types';
import { clearConfig, readConfig, writeConfig } from '../store/stores';

export type SessionContext = { session: Session; stale: boolean; staleSince: string | null };

export function logoutPlatform(runtime: Runtime): void {
  clearConfig(runtime.dataDir);
}

export async function refreshPlatform(runtime: Runtime): Promise<{ context: SessionContext | null; result: SessionResult }> {
  const config = readConfig(runtime.dataDir);
  if (!config.token) return { context: null, result: { ok: false, kind: 'rejected', message: 'Токен не задан. Выполните: ./stand login' } };
  const result = await fetchSession(config.platformUrl ?? runtime.platformUrl, config.token, runtime.version, await supportedPrimitives());
  if (result.ok) {
    writeConfig(runtime.dataDir, { session: result.session, lastOkAt: new Date().toISOString() });
    return { context: { session: result.session, stale: false, staleSince: null }, result };
  }
  if (result.kind === 'rejected') {
    writeConfig(runtime.dataDir, { token: null });
    return { context: null, result };
  }
  const grace = (config.session?.kit.offlineGraceHours ?? 0) * 3600_000;
  const since = config.lastOkAt ? Date.parse(config.lastOkAt) : NaN;
  const context = config.session && Number.isFinite(since) && Date.now() - since <= grace
    ? { session: config.session, stale: true, staleSince: config.lastOkAt } : null;
  return { context, result };
}

export function rememberLogin(runtime: Runtime, token: string, session: Session | null): void {
  writeConfig(runtime.dataDir, { platformUrl: runtime.platformUrl, token, session, lastOkAt: session ? new Date().toISOString() : null });
}
