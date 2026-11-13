import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntime } from '../config';
import { Controller, type ControllerDeps } from './controller';
import { PanelError } from './errors';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'panel-controller-'));
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: join(dir, 'data'), KIT_HOST_DIR: '/host/path with spaces', KIT_VERSION: '1.0.0' });
  writeFileSync(join(dir, 'VERSION'), runtime.version);
  let version = 'before'; let executions = 0;
  const deps: ControllerDeps = {
    refresh: async () => ({ context: null, result: { ok: false, kind: 'rejected', message: 'Нет подключения' } }),
    preview: async () => ({ allowed: true, targets: ['safe'], consequences: ['Удаляет данные'], confirmationRequired: true }),
    observe: async () => ({ revision: version, modules: [], activeTask: null, scenario: { state: 'known', label: 'label' } }),
    execute: async () => { executions += 1; return { ok: true }; },
  };
  const controller = new Controller(runtime, '1.0.0-abc', deps);
  return { dir, runtime, controller, deps, setVersion: (value: string) => { version = value; }, executions: () => executions, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('plan confirmation, durable intent and repeated submit return exactly one operation', async () => {
  const f = fixture();
  try {
    const plan = await f.controller.plan({ action: 'module.reset', moduleKey: 'safe' }, 'request-1');
    await assert.rejects(f.controller.submit(plan.planId), (error) => error instanceof PanelError && error.code === 'CONFIRMATION_REQUIRED');
    const id = await f.controller.submit(plan.planId, { checked: true, token: plan.confirmationToken! });
    assert.equal(f.controller.get(id).state, 'QUEUED');
    assert.equal(f.executions(), 0);
    assert.equal(await f.controller.submit(plan.planId), id);
    await tick(); await tick();
    assert.equal(f.controller.get(id).state, 'SUCCEEDED'); assert.equal(f.executions(), 1);
    assert.equal(statSync(join(f.dir, 'data/panel/state.json')).mode & 0o777, 0o600);
    const saved = JSON.parse(readFileSync(join(f.dir, 'data/panel/state.json'), 'utf8'));
    assert.equal(saved.consumed.includes(plan.planId), true); assert.equal(saved.operations[0].id, id);
    const reopened = new Controller(f.runtime, 'new-ui', f.deps);
    assert.equal(await reopened.submit(plan.planId), id);
    const now = Date.now();
    reopened.store.retain(now + 3 * 60_000);
    assert.equal(reopened.get(id).state, 'SUCCEEDED');
    assert.equal(await reopened.submit(plan.planId), id);
    await assert.rejects(reopened.plan(plan.payload, plan.clientRequestId), (error) => error instanceof PanelError && error.code === 'REQUEST_COMPLETED');
    reopened.store.retain(now + 31 * 86400_000);
    await assert.rejects(reopened.submit(plan.planId), (error) => error instanceof PanelError && error.code === 'PLAN_EXPIRED');
    assert.throws(() => reopened.get(id), (error) => error instanceof PanelError && error.code === 'OPERATION_UNKNOWN');
    assert.equal(f.executions(), 1);
  } finally { f.cleanup(); }
});

test('state change, expiration and reused request with different contents cannot execute', async () => {
  const f = fixture();
  try {
    const plan = await f.controller.plan({ action: 'module.reset', moduleKey: 'safe' }, 'request-1');
    await assert.rejects(f.controller.plan({ action: 'module.stop', moduleKey: 'safe' }, 'request-1'), (error) => error instanceof PanelError && error.code === 'REQUEST_CONFLICT');
    f.setVersion('after');
    await assert.rejects(f.controller.submit(plan.planId, { checked: true, token: plan.confirmationToken! }), (error) => error instanceof PanelError && error.code === 'PLAN_STALE');
    f.controller.store.commit((state) => { state.plans[plan.planId]!.expiresAt = new Date(0).toISOString(); });
    await assert.rejects(f.controller.submit(plan.planId), (error) => error instanceof PanelError && error.status === 410);
    assert.equal(f.executions(), 0);
  } finally { f.cleanup(); }
});

test('queued cancellation and competing operations never begin a second side effect', async () => {
  const f = fixture();
  try {
    const first = await f.controller.plan({ action: 'module.reset', moduleKey: 'safe' }, 'first');
    const second = await f.controller.plan({ action: 'module.reset', moduleKey: 'other' }, 'second');
    const id = await f.controller.submit(first.planId, { checked: true, token: first.confirmationToken! });
    await assert.rejects(f.controller.submit(second.planId, { checked: true, token: second.confirmationToken! }), (error) => error instanceof PanelError && error.code === 'OPERATION_CONFLICT');
    f.controller.cancel(id); await tick(); assert.equal(f.executions(), 0); assert.equal(f.controller.get(id).state, 'CANCELLED');
  } finally { f.cleanup(); }
});

test('intent disk failure prevents side effects; interrupted operations never replay', async () => {
  const f = fixture();
  try {
    const plan = await f.controller.plan({ action: 'module.reset', moduleKey: 'safe' }, 'first');
    const path = join(f.dir, 'data/panel/state.json'); rmSync(path); mkdirSync(path);
    await assert.rejects(f.controller.submit(plan.planId, { checked: true, token: plan.confirmationToken! }));
    await tick(); assert.equal(f.executions(), 0); assert.equal(f.controller.store.state.operations.length, 0);
    rmSync(path, { recursive: true });
    const id = await f.controller.submit(plan.planId, { checked: true, token: plan.confirmationToken! });
    const reopened = new Controller(f.runtime, 'new', f.deps);
    assert.equal(reopened.get(id).state, 'INTERRUPTED'); assert.equal(reopened.get(id).retryAllowed, true);
    f.controller.cancel(id); await tick(); assert.equal(f.executions(), 0);
  } finally { f.cleanup(); }
});

test('mutation reservation rejects concurrency before asynchronous refresh completes', async () => {
  const f = fixture(); let release!: () => void;
  try {
    const blocking = f.controller.control(async () => { await new Promise<void>((resolve) => { release = resolve; }); return 1; });
    await assert.rejects(f.controller.control(async () => 2), (error) => error instanceof PanelError && error.code === 'OPERATION_CONFLICT');
    release(); assert.equal(await blocking, 1);
  } finally { f.cleanup(); }
});

test('agent revoke receives the next boundary and prevents the following step', async () => {
  const f = fixture(); const sequence: string[] = []; let next!: () => void;
  try {
    f.deps.execute = async (ctx, request) => {
      if (request.action === 'policy.enforce') { sequence.push('policy'); return { ok: true }; }
      sequence.push('first-step'); await new Promise<void>((resolve) => { next = resolve; });
      const current = await ctx.revalidate?.();
      if (!current) return { ok: false, code: 'SESSION_REQUIRED' };
      sequence.push('forbidden-second-step'); return { ok: true };
    };
    const plan = await f.controller.plan({ action: 'module.reset', moduleKey: 'safe' }, 'revoke');
    const id = await f.controller.submit(plan.planId, { checked: true, token: plan.confirmationToken! });
    await tick(); assert.deepEqual(sequence, ['first-step']);
    assert.throws(() => f.controller.cancel(id), (error) => error instanceof PanelError && error.code === 'CANCEL_UNSAFE');
    await f.controller.enforce(); assert.deepEqual(sequence, ['first-step']);
    next(); await tick(); await tick();
    assert.deepEqual(sequence, ['first-step', 'policy']); assert.equal(f.controller.get(id).state, 'FAILED');
  } finally { f.cleanup(); }
});
