import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { loadRuntime } from '../config';
import { bootstrap, browserSession, mintBootstrap, validateHeaders } from './auth';
import { PanelStore } from './store';
import { parseAction } from './validation';
import { PanelError } from './errors';

const request = (headers: IncomingMessage['headers'], method = 'GET') => ({ headers, method }) as IncomingMessage;

test('bootstrap is single use, expires and sessions survive controller replacement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-auth-'));
  try {
    const runtime = loadRuntime({ KIT_DATA_DIR: dir, KIT_HOST_DIR: '/my kit' }); const store = new PanelStore(runtime);
    const nonce = mintBootstrap(store); assert.equal(Buffer.from(nonce, 'base64url').length, 32);
    const session = bootstrap(store, nonce);
    assert.throws(() => bootstrap(store, nonce), (error) => error instanceof PanelError && error.status === 410);
    const req = request({ cookie: `stand_session=${session.id}`, 'x-csrf-token': session.csrf });
    assert.equal(browserSession(new PanelStore(runtime), req, true).id, session.id);
    assert.throws(() => browserSession(store, request({ cookie: `stand_session=${session.id}` }), true));
    store.commit((state) => { state.sessions[0]!.expiresAt = 0; }); assert.throws(() => browserSession(store, req, false));
    const expired = mintBootstrap(store); store.commit((state) => { for (const key of Object.keys(state.bootstraps)) state.bootstraps[key] = 0; }); assert.throws(() => bootstrap(store, expired));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict host, origin, fetch metadata and websocket boundaries', () => {
  assert.equal(validateHeaders(request({ host: '127.0.0.1:18490' })), 'browser');
  assert.equal(validateHeaders(request({ host: 'stands-kit-panel:18490' }, 'POST')), 'internal');
  for (const headers of [{ host: 'evil.example' }, { host: 'localhost:18490' }, { host: '127.0.0.1:18490', origin: 'null' }, { host: '127.0.0.1:18490', origin: 'https://evil.test' }, { host: '127.0.0.1:18490', 'sec-fetch-site': 'cross-site' }, { host: '127.0.0.1:18490', upgrade: 'websocket' }]) assert.throws(() => validateHeaders(request(headers)));
  assert.throws(() => validateHeaders(request({ host: '127.0.0.1:18490' }, 'POST')));
});

test('actions accept server keys and reject shell/container/profile/client URL', () => {
  assert.deepEqual(parseAction({ action: 'module.start', target: 'kit-bank', clientRequestId: 'one' }), { action: 'module.start', moduleKey: 'kit-bank' });
  for (const extra of ['shell', 'containerId', 'profile', 'platformUrl', 'composeFile']) assert.throws(() => parseAction({ action: 'module.start', target: 'safe', [extra]: 'evil' }));
  assert.throws(() => parseAction({ action: 'policy.enforce' })); assert.throws(() => parseAction({ action: 'task.verify', target: 'task' }));
});

test('several tabs and repeated launcher bootstrap reuse the cookie and CSRF without replaying the nonce', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-tabs-'));
  try {
    const store = new PanelStore(loadRuntime({ KIT_DATA_DIR: dir, KIT_HOST_DIR: '/my kit' }));
    const original = bootstrap(store, mintBootstrap(store));
    const cookie = `stand_session=${original.id}`; const secondNonce = mintBootstrap(store);
    const second = bootstrap(store, secondNonce, cookie);
    assert.equal(second.id, original.id); assert.equal(second.csrf, original.csrf); assert.equal(second.expiresAt, original.expiresAt);
    assert.equal(store.state.sessions.length, 1);
    assert.equal(browserSession(store, request({ cookie, 'x-csrf-token': original.csrf }), true).id, original.id);
    assert.throws(() => bootstrap(store, secondNonce, cookie), (error) => error instanceof PanelError && error.status === 410);
    const third = bootstrap(store, mintBootstrap(store), cookie); assert.equal(third.csrf, original.csrf);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
