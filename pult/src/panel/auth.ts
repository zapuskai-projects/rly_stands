import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { digest, secret } from './durable';
import { PanelError } from './errors';
import type { PanelStore } from './store';
import type { LocalSession } from './types';

export const PUBLIC_HOST = '127.0.0.1:18490';
export const PUBLIC_ORIGIN = `http://${PUBLIC_HOST}`;
export function secureEqual(left: string | undefined, right: string): boolean {
  return typeof left === 'string' && timingSafeEqual(Buffer.from(digest(left)), Buffer.from(digest(right)));
}
export function validateHeaders(req: IncomingMessage): 'browser' | 'internal' {
  if (req.headers.upgrade || req.headers.origin === 'null' || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) throw new PanelError(403, 'ORIGIN_DENIED', 'Запрос разрешён только из локальной панели');
  if (req.headers.host === 'stands-kit-panel:18490' && !req.headers.origin) return 'internal';
  if (req.headers.host !== PUBLIC_HOST || (req.headers.origin && req.headers.origin !== PUBLIC_ORIGIN)) throw new PanelError(403, 'ORIGIN_DENIED', 'Неверный Host или Origin');
  if (!['GET', 'HEAD'].includes(req.method ?? '') && req.headers.origin !== PUBLIC_ORIGIN) throw new PanelError(403, 'ORIGIN_REQUIRED', 'Нужен локальный Origin');
  return 'browser';
}
export function mintBootstrap(store: PanelStore): string {
  const nonce = secret();
  store.commit((state) => { state.bootstraps[digest(nonce)] = Date.now() + 120000; });
  return nonce;
}
export function bootstrap(store: PanelStore, nonce: string, cookie?: string): LocalSession {
  const key = digest(nonce);
  if ((store.state.bootstraps[key] ?? 0) <= Date.now()) throw new PanelError(410, 'BOOTSTRAP_EXPIRED', 'Ссылка подключения истекла или уже использована; запустите ./stand');
  const existing = findSession(store, cookie);
  const session = existing ?? { id: secret(), csrf: secret(), fingerprint: store.fingerprint, expiresAt: Date.now() + 12 * 3600000 };
  store.commit((state) => { delete state.bootstraps[key]; if (!existing) state.sessions.push(session); });
  return session;
}
function findSession(store: PanelStore, cookie?: string): LocalSession | undefined {
  const id = cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith('stand_session='))?.slice('stand_session='.length);
  return store.state.sessions.find((item) => secureEqual(id, item.id) && item.fingerprint === store.fingerprint && item.expiresAt > Date.now());
}
export function browserSession(store: PanelStore, req: IncomingMessage, mutation: boolean): LocalSession {
  const session = findSession(store, req.headers.cookie);
  if (!session) throw new PanelError(401, 'LOCAL_SESSION_REQUIRED', 'Запустите ./stand для подключения браузера');
  if (mutation && !secureEqual(String(req.headers['x-csrf-token'] ?? ''), session.csrf)) throw new PanelError(403, 'CSRF_REQUIRED', 'Неверный CSRF token');
  return session;
}
