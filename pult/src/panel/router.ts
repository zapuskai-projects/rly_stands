import { bridge } from './handoff';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { composeConfig, listKitContainers } from '../docker/kit-docker';
import { run } from '../docker/exec';
import { rememberLogin } from '../actions/session';
import { readConfig, takeNotices } from '../store/stores';
import type { Session } from '../platform/types';
import { bootstrap, browserSession, mintBootstrap, secureEqual, validateHeaders } from './auth';
import type { Controller } from './controller';
import { DeviceLogins } from './device';
import { PanelError, requireObject, stringField } from './errors';
import { Snapshots } from './snapshot';
import { listWork, readWork, saveWork } from './work';
import { pageNumber, parseAction } from './validation';

export function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(JSON.stringify(value));
}
async function bodyOf(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new PanelError(415, 'JSON_REQUIRED', 'Нужен Content-Type application/json');
  let length = 0; const chunks: Buffer[] = [];
  for await (const raw of req) {
    const chunk = Buffer.from(raw as Buffer); length += chunk.length;
    if (length > 6 * 1024 * 1024) throw new PanelError(413, 'BODY_TOO_LARGE', 'Запрос слишком большой');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new PanelError(400, 'INVALID_JSON', 'Неверный JSON'); }
}
function confirmationOf(value: unknown): { checked: boolean; token: string } | undefined {
  if (value === undefined) return undefined;
  const body = requireObject(value, ['checked', 'token']);
  if (body.checked !== true) throw new PanelError(400, 'CONFIRMATION_REQUIRED', 'Нужно отметить подтверждение');
  return { checked: true, token: stringField(body.token) };
}
export type PanelMeta = { instanceId: string; uiBuildId: string; apiProtocolVersion: number; version: string };
export class Router {
  private snapshots: Snapshots;
  private devices: DeviceLogins;
  constructor(readonly controller: Controller, readonly meta: PanelMeta, readonly assets: string) { this.snapshots = new Snapshots(controller.runtime, controller.store); this.devices = new DeviceLogins(controller); }
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const mode = validateHeaders(req);
      const url = new URL(req.url ?? '/', 'http://127.0.0.1:18490');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const mutation = !['GET', 'HEAD'].includes(method);
      if (mode === 'internal') {
        if (!path.startsWith('/internal/') || !secureEqual(String(req.headers['x-panel-key'] ?? ''), this.controller.store.internalKey)) throw new PanelError(403, 'INTERNAL_KEY_REQUIRED', 'Неверный внутренний ключ');
        await this.internal(req, res, path); return;
      }
      if (path.startsWith('/internal/')) throw new PanelError(403, 'INTERNAL_ONLY', 'Внутренний маршрут');
      if (path === '/api/meta' && method === 'GET') { json(res, 200, this.meta); return; }
      if (path === '/api/session/bootstrap' && method === 'POST') {
        const body = requireObject(await bodyOf(req), ['nonce']);
        const session = bootstrap(this.controller.store, stringField(body.nonce), req.headers.cookie);
        res.setHeader('Set-Cookie', `stand_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
        json(res, 200, { csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() }); return;
      }
      if (!path.startsWith('/api/')) { if (mutation) throw new PanelError(405, 'METHOD_DENIED', 'Метод не разрешён'); this.static(res, path); return; }
      const session = browserSession(this.controller.store, req, mutation);
      if (mutation && req.headers['x-ui-build-id'] !== this.meta.uiBuildId) throw new PanelError(409, 'UI_RELOAD_REQUIRED', 'Загрузите новую версию панели');
      if (path === '/api/session' && method === 'GET') { json(res, 200, { csrfToken: session.csrf, expiresAt: new Date(session.expiresAt).toISOString() }); return; }
      if (path === '/api/session/logout' && method === 'POST') {
        requireObject(await bodyOf(req), []);
        this.controller.store.commit((state) => { state.sessions = state.sessions.filter((item) => item.id !== session.id); });
        res.setHeader('Set-Cookie', 'stand_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); json(res, 200, { ok: true }); return;
      }
      if (path === '/api/state' && method === 'GET') { json(res, 200, await this.snapshots.get()); return; }
      if (path === '/api/plans' && method === 'POST') {
        const body = requireObject(await bodyOf(req), ['action', 'target', 'version', 'clientRequestId']);
        const request = parseAction(body); const requestId = stringField(body.clientRequestId, 128);
        json(res, 200, await this.controller.control(() => this.controller.plan(request, requestId))); return;
      }
      if (path === '/api/operations' && method === 'POST') {
        const body = requireObject(await bodyOf(req), ['planId', 'confirmation']);
        const planId = stringField(body.planId);
        const existing = this.controller.store.state.tombstones[`plan:${planId}`];
        const operationId = existing?.operationId ?? await this.controller.control(() => this.controller.submit(planId, confirmationOf(body.confirmation)));
        json(res, 202, { operationId }); return;
      }
      if (path === '/api/operations' && method === 'GET') {
        const offset = pageNumber(url.searchParams.get('offset'), 0, 1000000); const limit = pageNumber(url.searchParams.get('limit'), 25, 100);
        const requestId = url.searchParams.get('requestId');
        const ops = [...this.controller.store.state.operations].reverse().filter((item) => !requestId || item.requestId === requestId); json(res, 200, { operations: ops.slice(offset, offset + limit), total: ops.length, offset, limit }); return;
      }
      const operation = /^\/api\/operations\/([A-Za-z0-9_-]+)(\/cancel)?$/.exec(path);
      if (operation && method === (operation[2] ? 'POST' : 'GET')) {
        if (operation[2]) { requireObject(await bodyOf(req), []); json(res, 200, this.controller.cancel(operation[1]!)); }
        else json(res, 200, this.controller.get(operation[1]!));
        return;
      }
      if (path === '/api/work' && method === 'GET') { json(res, 200, listWork(this.controller.runtime, pageNumber(url.searchParams.get('offset'), 0, 1000000), pageNumber(url.searchParams.get('limit'), 50, 100))); return; }
      if (path === '/api/work/file' && method === 'GET') {
        const file = readWork(this.controller.runtime, stringField(url.searchParams.get('path'), 4096)); res.setHeader('ETag', file.etag); json(res, 200, file); return;
      }
      if (path === '/api/work/file' && method === 'PUT') {
        const body = requireObject(await bodyOf(req), ['path', 'text']);
        if (typeof body.text !== 'string') throw new PanelError(400, 'INVALID_BODY', 'Нужен текст');
        const file = await this.controller.control(async () => saveWork(this.controller.runtime, stringField(body.path, 4096), body.text as string, req.headers['if-match'] as string | undefined));
        res.setHeader('ETag', file.etag); json(res, 200, file); return;
      }
      const logs = /^\/api\/modules\/([^/]+)\/logs$/.exec(path);
      if (logs && method === 'GET') { json(res, 200, await this.logs(decodeURIComponent(logs[1]!), pageNumber(url.searchParams.get('tail'), 100, 500))); return; }
      if (path === '/api/device-login' && method === 'POST') { requireObject(await bodyOf(req), []); json(res, 200, await this.controller.control(() => this.devices.start())); return; }
      const device = /^\/api\/device-login\/([A-Za-z0-9_-]+)$/.exec(path);
      if (device && method === 'GET') {
        const value = this.controller.active() ? await this.devices.get(device[1]!) : await this.controller.control(() => this.devices.get(device[1]!));
        json(res, 200, value); return;
      }
      throw new PanelError(404, 'NOT_FOUND', 'Маршрут не найден');
    } catch (error) {
      const failure = error instanceof PanelError ? error : new PanelError(500, 'REQUEST_FAILED', error instanceof Error && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'Файл недоступен или содержит ссылку' : 'Запрос не выполнен; проверьте состояние и повторите');
      json(res, failure.status, { error: { code: failure.code, message: failure.message, ...(failure.details ? { details: failure.details } : {}) } });
    }
  }
  private async internal(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method;
    if (path === '/internal/meta' && method === 'GET') { json(res, 200, this.meta); return; }
    const op = /^\/internal\/operations\/([A-Za-z0-9_-]+)$/.exec(path);
    if (op && method === 'GET') { json(res, 200, this.controller.get(op[1]!)); return; }
    if (method !== 'POST') throw new PanelError(405, 'METHOD_DENIED', 'Метод не разрешён');
    if (path === '/internal/bridge') { json(res, 200, await bridge(this.controller, await bodyOf(req))); return; }
    if (path === '/internal/bootstrap') { requireObject(await bodyOf(req), []); json(res, 200, { nonce: mintBootstrap(this.controller.store) }); return; }
    if (path === '/internal/policy') { requireObject(await bodyOf(req), []); await this.controller.enforce(); json(res, 200, { ok: true }); return; }
    if (path === '/internal/plan') {
      const body = requireObject(await bodyOf(req), ['request', 'clientRequestId']);
      json(res, 200, await this.controller.control(() => this.controller.plan(parseAction(body.request, true), stringField(body.clientRequestId, 128)))); return;
    }
    if (path === '/internal/operation') {
      const body = requireObject(await bodyOf(req), ['planId', 'confirmation']);
      const planId = stringField(body.planId);
      const prior = this.controller.store.state.tombstones[`plan:${planId}`];
      const operationId = prior?.operationId ?? await this.controller.control(() => this.controller.submit(planId, confirmationOf(body.confirmation)));
      json(res, 202, { operationId }); return;
    }
    if (path === '/internal/notices') { requireObject(await bodyOf(req), []); const notices = await this.controller.control(async () => takeNotices(this.controller.runtime.dataDir)); json(res, 200, notices); return; }
    if (path === '/internal/login') {
      const body = requireObject(await bodyOf(req), ['token', 'session']);
      await this.controller.control(async () => rememberLogin(this.controller.runtime, stringField(body.token, 4096), body.session as Session | null));
      json(res, 200, { ok: true }); return;
    }
    throw new PanelError(404, 'NOT_FOUND', 'Внутренний маршрут не найден');
  }
  private static(res: ServerResponse, path: string): void {
    if (path !== '/' && !/^\/[A-Za-z0-9_.-]+$/.test(path)) throw new PanelError(404, 'NOT_FOUND', 'Файл не найден');
    const file = join(this.assets, path === '/' ? 'index.html' : path.slice(1));
    if (!statSync(file).isFile()) throw new PanelError(404, 'NOT_FOUND', 'Файл не найден');
    const contentType = ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' } as Record<string, string>)[extname(file)];
    if (!contentType) throw new PanelError(404, 'NOT_FOUND', 'Файл не найден');
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': extname(file) === '.html' || extname(file) === '.json' ? 'no-store' : /[.-][a-f0-9]{8,}[.-]/.test(file) ? 'public, max-age=31536000, immutable' : 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); res.end(readFileSync(file));
  }
  private async logs(key: string, tail: number) {
    const module = readConfig(this.controller.runtime.dataDir).session?.modules.find((item) => item.key === key);
    if (!module) throw new PanelError(403, 'MODULE_UNAVAILABLE', 'Стенд отсутствует в назначениях');
    const config = await composeConfig(this.controller.runtime, [module.profile]) as { services?: Record<string, { container_name?: string }> } | null;
    if (!config?.services) throw new PanelError(503, 'DOCKER_UNKNOWN', 'Не удалось прочитать состав стенда');
    const expected = new Set(Object.values(config.services).map((service) => service.container_name));
    const containers = (await listKitContainers()).filter((item) => item.profile === module.profile && expected.has(item.name));
    const logs = await Promise.all(containers.map(async (container) => {
      const result = await run('docker', ['logs', '--tail', String(tail), '--timestamps', container.name], { timeoutMs: 10000 });
      return { name: container.name, text: this.controller.redactText(`${result.stdout}${result.stderr}`).slice(-256 * 1024), available: result.code === 0 };
    }));
    return { moduleKey: key, checkedAt: new Date().toISOString(), logs };
  }
}
