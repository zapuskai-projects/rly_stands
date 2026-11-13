import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntime } from '../config';
import type { Session } from '../platform/types';
import { readConfig, writeConfig } from '../store/stores';
import { routeAction } from './gateway';
import { kitFingerprint } from './store';

const session = { user: { name: 'Ученик' }, token: { expiresAt: '2099-01-01' }, kit: { minVersion: '1.0', latestVersion: '1.0', offlineGraceHours: 24 }, modules: [{ key: 'safe', title: 'Стенд', profile: 'safe', minMemoryMb: 1, allowed: true, reason: null, uis: [] }], tasks: [] } satisfies Session;
const progress = { info: () => undefined, ok: () => undefined, fail: () => undefined };

test('standalone CLI route refreshes a live session and rejects revoked access before side effects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-gateway-'));
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: dir, KIT_VERSION: '1.0', STAND_PLATFORM_URL: 'https://platform.test' });
  try {
    writeConfig(dir, { token: 'sk_fixture', session, platformUrl: runtime.platformUrl, lastOkAt: new Date().toISOString() });
    const fetch = mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(session), { status: 200 }));
    const live = await routeAction({ runtime, session, progress }, { action: 'platform.refresh' });
    assert.equal(live.ok, true); assert.equal(live.sessionContext?.session.user.name, 'Ученик'); assert.ok(fetch.mock.callCount() >= 3);
    fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ message: 'Отозван' }), { status: 401 }));
    let steps = 0;
    const denied = await routeAction({ runtime, session, progress, beforeStep: async () => { steps += 1; } }, { action: 'module.start', moduleKey: 'safe' });
    assert.equal(denied.code, 'SESSION_REQUIRED'); assert.equal(steps, 0); assert.equal(readConfig(dir).token, null);
  } finally { mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
});

test('an accepted remote operation with an unknown response never falls back to direct execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-unknown-'));
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: dir, KIT_VERSION: '1.0' });
  mkdirSync(join(dir, 'panel')); writeFileSync(join(dir, 'panel/controller.json'), JSON.stringify({ fingerprint: kitFingerprint(runtime) })); writeFileSync(join(dir, 'panel/internal-key'), 'private-key');
  try {
    mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const path = new URL(String(input)).pathname;
      if (path === '/internal/meta') return new Response('{}');
      if (path === '/internal/plan') return new Response(JSON.stringify({ allowed: true, planId: 'plan', confirmationRequired: false }));
      if (path === '/internal/operation') return new Response(JSON.stringify({ operationId: 'accepted-operation' }));
      throw new Error('Связь прервана');
    });
    const result = await routeAction({ runtime, session, progress }, { action: 'module.reset', moduleKey: 'safe' });
    assert.equal(result.ok, false); assert.equal(result.code, 'CONTROLLER_UNAVAILABLE');
    assert.equal(existsSync(join(dir, 'writer.lock')), false);
  } finally { mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
});

test('bridge completion has a deadline covering heavy reconcile, normal reads remain bounded', async () => {
  const { internalTimeout } = await import('./internal-http.js');
  assert.equal(internalTimeout('/internal/bridge', { verb: 'complete' }), 30 * 60000);
  assert.equal(internalTimeout('/internal/bridge', { verb: 'heartbeat' }), 15000);
  assert.equal(internalTimeout('/internal/plan'), 120000);
  assert.equal(internalTimeout('/internal/operations/one'), 15000);
});
