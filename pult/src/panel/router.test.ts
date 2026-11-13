import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntime } from '../config';
import { Controller, type ControllerDeps } from './controller';
import { Router } from './router';
import { mintBootstrap } from './auth';

const deps: ControllerDeps = {
  refresh: async () => ({ context: null, result: { ok: false, kind: 'rejected', message: 'Нет токена' } }),
  preview: async () => ({ allowed: true, targets: [], consequences: [], confirmationRequired: false }),
  observe: async () => ({ revision: 'one', modules: [], activeTask: null, scenario: null }),
  execute: async () => ({ ok: true }),
};
async function request(router: Router, path: string, method = 'GET', body?: unknown, headers: IncomingMessage['headers'] = {}) {
  const stream = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as IncomingMessage;
  stream.url = path; stream.method = method; stream.headers = { host: '127.0.0.1:18490', ...(body === undefined ? {} : { origin: 'http://127.0.0.1:18490', 'content-type': 'application/json' }), ...headers };
  const output = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = { setHeader: (name: string, value: string) => { output.headers[name.toLowerCase()] = value; }, writeHead: (status: number, values: Record<string, string>) => { output.status = status; Object.assign(output.headers, values); }, end: (value: string | Buffer) => { output.body = String(value); } } as unknown as ServerResponse;
  await router.handle(stream, res); return output;
}

test('HTTP adapters enforce bootstrap, session, CSRF, build id, DTO and idempotent operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-router-'));
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: join(dir, 'data'), KIT_HOST_DIR: '/host/kit', KIT_VERSION: '1' });
  const controller = new Controller(runtime, 'ui1', deps); const router = new Router(controller, { instanceId: 'instance', version: '1', uiBuildId: 'ui1', apiProtocolVersion: 1 }, dir);
  writeFileSync(join(dir, 'index.html'), '<html>Подключение</html>');
  try {
    assert.equal((await request(router, '/')).status, 200);
    assert.equal((await request(router, '/api/operations')).status, 401);
    assert.equal((await request(router, '/api/meta', 'GET', undefined, { host: 'evil.test' })).status, 403);
    const nonce = mintBootstrap(controller.store);
    const connected = await request(router, '/api/session/bootstrap', 'POST', { nonce });
    assert.equal(connected.status, 200); assert.equal(connected.body.includes(nonce), false);
    assert.match(connected.headers['set-cookie']!, /HttpOnly; SameSite=Strict/);
    const csrf = JSON.parse(connected.body).csrfToken;
    const headers = { cookie: connected.headers['set-cookie']!, 'x-csrf-token': csrf, 'x-ui-build-id': 'ui1' };
    assert.equal((await request(router, '/api/session/bootstrap', 'POST', { nonce })).status, 410);
    const secondTab = await request(router, '/api/session/bootstrap', 'POST', { nonce: mintBootstrap(controller.store) }, { cookie: headers.cookie });
    assert.equal(secondTab.status, 200); assert.equal(secondTab.headers['set-cookie'], connected.headers['set-cookie']); assert.equal(JSON.parse(secondTab.body).csrfToken, csrf);
    assert.equal((await request(router, '/api/session', 'GET', undefined, headers)).status, 200);
    assert.equal((await request(router, '/api/plans', 'POST', { action: 'diagnostics.run', clientRequestId: 'req' }, { ...headers, 'x-csrf-token': '' })).status, 403);
    assert.equal((await request(router, '/api/plans', 'POST', { action: 'diagnostics.run', clientRequestId: 'req' }, { ...headers, 'x-ui-build-id': 'old' })).status, 409);
    assert.equal((await request(router, '/api/plans', 'POST', { action: 'module.start', target: 'safe', shell: 'rm', clientRequestId: 'req' }, headers)).status, 400);
    const planned = await request(router, '/api/plans', 'POST', { action: 'diagnostics.run', clientRequestId: 'req' }, headers); assert.equal(planned.status, 200);
    const planId = JSON.parse(planned.body).planId;
    const accepted = await request(router, '/api/operations', 'POST', { planId }, headers); assert.equal(accepted.status, 202);
    const repeat = await request(router, '/api/operations', 'POST', { planId }, headers); assert.equal(repeat.body, accepted.body);
    await new Promise<void>((resolve) => setImmediate(resolve)); await new Promise<void>((resolve) => setImmediate(resolve));
    const opId = JSON.parse(accepted.body).operationId; assert.equal((await request(router, `/api/operations/${opId}`, 'GET', undefined, headers)).status, 200);
    const firstPage = JSON.parse((await request(router, '/api/operations?limit=1', 'GET', undefined, headers)).body);
    assert.equal(firstPage.operations[0].id, opId);
    const nextPage = JSON.parse((await request(router, '/api/operations?offset=1&limit=1', 'GET', undefined, headers)).body);
    assert.equal(nextPage.total, 1); assert.deepEqual(nextPage.operations, []);
    assert.equal((await request(router, '/internal/meta', 'GET', undefined, headers)).status, 403);
    assert.equal((await request(router, '/internal/meta', 'GET', undefined, { host: 'stands-kit-panel:18490', 'x-panel-key': controller.store.internalKey })).status, 200);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
