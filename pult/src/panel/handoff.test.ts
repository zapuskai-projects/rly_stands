import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntime } from '../config';
import { Controller } from './controller';
import { bridge, checkCheckout, markPrepared } from './handoff';
import { type Operation } from './types';
import { clearUpdateMarker, writeConfig, writeUpdateMarker } from '../store/stores';
import { clearStarting, markStarting } from '../store/starting';
import { PanelError } from './errors';

test('смена пульта оставляет подтверждённый запрос тому же bridge и проверяет версию checkout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-handoff-'));
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: join(dir, 'data'), KIT_VERSION: '1.0.0' });
  writeFileSync(join(dir, 'VERSION'), runtime.version);
  try {
    const c = new Controller(runtime, '1.0.0-old');
    const t = new Date().toISOString();
    const op: Operation = { id: 'operation', requestId: 'request', action: { action: 'update.prepare', version: '1.0.1' },
      state: 'RUNNING', stage: '', uiBuildId: c.uiBuildId, targets: [], payloadHash: '', createdAt: t, updatedAt: t,
      observedStateBefore: {}, events: [], cancelAllowed: false, retryAllowed: false };
    markPrepared(c, op, '1.0.1');
    c.store.commit((s) => s.operations.push(op));
    assert.deepEqual(await bridge(c, { verb: 'tick', pid: '42' }), { value: 'operation 1.0.1' });
    assert.deepEqual(await bridge(c, { verb: 'tick', pid: '43' }), { value: 'busy:42' });
    assert.throws(() => checkCheckout(c, 'task.start'), /завершения обновления/);
    assert.doesNotThrow(() => checkCheckout(c, 'module.stop'));
    await assert.rejects(bridge(c, { verb: 'complete', pid: '42', id: 'operation', version: '1.0.1' }), /не готовы/);
    const restart = new Controller(runtime, '1.0.0-old');
    assert.equal(restart.get('operation').state, 'WAITING_CONFIRMATION');
    assert.equal(restart.get('operation').handoff?.phase, 'switching');
    await bridge(restart, { verb: 'reclaim', pid: '43', previous: '42' });
    await bridge(restart, { verb: 'failed', pid: '43', id: 'operation', version: '1.0.1', reason: 'В папке есть изменения' });
    assert.equal(restart.get('operation').error?.message, 'В папке есть изменения');
    const retry = { ...op, id: 'retry' };
    markPrepared(restart, retry, '1.0.1');
    assert.equal(retry.handoff?.oldBuild, '1.0.0-old');
    restart.store.commit((state) => state.operations.push(retry));
    assert.deepEqual(await bridge(restart, { verb: 'tick', pid: '43' }), { value: 'retry 1.0.1' });
    await assert.rejects(bridge(restart, { verb: 'complete', pid: '43', id: 'retry', version: '1.0.1' }), /не готовы/);
    writeFileSync(join(dir, 'VERSION'), '1.0.1');
    assert.throws(() => checkCheckout(restart, 'module.restart'), /Версия файлов/);
    const session = { user: { name: 'Ученик' }, token: { expiresAt: '2099-01-01' }, kit: { minVersion: '1.0.0', latestVersion: '1.0.1', offlineGraceHours: 24 }, modules: [], tasks: [] };
    writeConfig(runtime.dataDir, { token: 'sk_fixture', session });
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(session)));
    const replaced = new Controller({ ...runtime, version: '1.0.1' }, '1.0.1-new');
    assert.deepEqual(await bridge(replaced, { verb: 'complete', pid: '43', id: 'retry', version: '1.0.1' }), { value: 'complete' });
  } finally { mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
});

for (const code of ['SESSION_REQUIRED', 'RECONCILE_FAILED']) test(`повтор после ${code} сохраняет исходную смену сборки и завершает обновление`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-handoff-retry-'));
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: join(dir, 'data'), KIT_VERSION: '1.0.0' });
  writeFileSync(join(dir, 'VERSION'), runtime.version);
  try {
    const old = new Controller(runtime, '1.0.0-old');
    const time = new Date().toISOString();
    const operation = (id: string): Operation => ({ id, requestId: id, action: { action: 'update.prepare', version: '1.0.1' },
      state: 'RUNNING', stage: '', uiBuildId: old.uiBuildId, targets: [], payloadHash: '', createdAt: time, updatedAt: time,
      observedStateBefore: {}, events: [], cancelAllowed: false, retryAllowed: false });
    const original = operation('original');
    markPrepared(old, original, '1.0.1'); old.store.commit((state) => state.operations.push(original));
    await bridge(old, { verb: 'tick', pid: '42' });
    writeFileSync(join(dir, 'VERSION'), '1.0.1');
    const current = new Controller({ ...runtime, version: '1.0.1' }, '1.0.1-new');
    const session = { user: { name: 'Ученик' }, token: { expiresAt: '2099-01-01' }, kit: { minVersion: '1.0.0', latestVersion: '1.0.1', offlineGraceHours: 24 }, modules: [], tasks: [] };
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(session)));
    if (code === 'RECONCILE_FAILED') {
      writeConfig(runtime.dataDir, { token: 'sk_fixture', session });
      writeUpdateMarker(runtime.dataDir, '1.0.1'); markStarting(runtime.dataDir, 'bank');
    }
    await assert.rejects(bridge(current, { verb: 'complete', pid: '42', id: 'original', version: '1.0.1' }), (error) => error instanceof PanelError && error.code === code);
    await bridge(current, { verb: 'failed', pid: '42', id: 'original', version: '1.0.1', reason: code });
    const retry = operation('retry'); markPrepared(current, retry, '1.0.1');
    assert.equal(retry.handoff?.oldBuild, '1.0.0-old');
    assert.equal(retry.handoff?.oldVersion, '1.0.0');
    current.store.commit((state) => state.operations.push(retry));
    const restarted = new Controller(current.runtime, current.uiBuildId);
    assert.deepEqual(await bridge(restarted, { verb: 'tick', pid: '42' }), { value: 'retry 1.0.1' });
    writeConfig(runtime.dataDir, { token: 'sk_fixture', session });
    clearStarting(runtime.dataDir, 'bank'); clearUpdateMarker(runtime.dataDir);
    assert.deepEqual(await bridge(restarted, { verb: 'complete', pid: '42', id: 'retry', version: '1.0.1' }), { value: 'complete' });
    assert.equal(restarted.get('retry').state, 'SUCCEEDED');
  } finally { mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
});

test('повтор на старом контроллере и первичное обновление без смены сборки не подтверждают замену', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-handoff-old-'));
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: join(dir, 'data'), KIT_VERSION: '1.0.1' });
  writeFileSync(join(dir, 'VERSION'), runtime.version);
  try {
    const controller = new Controller(runtime, '1.0.1-current');
    const time = new Date().toISOString();
    const op: Operation = { id: 'first', requestId: 'first', action: { action: 'update.prepare', version: '1.0.1' }, state: 'RUNNING', stage: '',
      uiBuildId: controller.uiBuildId, targets: [], payloadHash: '', createdAt: time, updatedAt: time, observedStateBefore: {}, events: [], cancelAllowed: false, retryAllowed: false };
    markPrepared(controller, op, '1.0.1'); controller.store.commit((state) => state.operations.push(op));
    await bridge(controller, { verb: 'tick', pid: '42' });
    await assert.rejects(bridge(controller, { verb: 'complete', pid: '42', id: 'first', version: '1.0.1' }), /не готовы/);
    await bridge(controller, { verb: 'failed', pid: '42', id: 'first', version: '1.0.1' });
    const retry = { ...op, id: 'retry' }; markPrepared(controller, retry, '1.0.1');
    assert.equal(retry.handoff?.oldBuild, controller.uiBuildId);
    controller.store.commit((state) => state.operations.push(retry));
    await bridge(controller, { verb: 'tick', pid: '42' });
    await assert.rejects(bridge(controller, { verb: 'complete', pid: '42', id: 'retry', version: '1.0.1' }), /не готовы/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
