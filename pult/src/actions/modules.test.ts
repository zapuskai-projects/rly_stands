import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import type { Session, SessionModule } from '../platform/types';
import type { CurrentTask } from '../store/stores';
import { writeCurrentTask } from '../store/stores';
import { restartPreservingData } from './modules';
import type { ActionContext } from './types';

const bank = { key: 'kit-bank', profile: 'bank', allowed: true } as SessionModule;

for (const active of [true, false]) {
  it(`restart восстанавливает недоступный банк; локальная задача ${active ? 'есть' : 'потеряна'}`, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'kit-restart-'));
    try {
      if (active) writeCurrentTask(dataDir, { label: 'lbl1', modules: [{ key: bank.key }] } as CurrentTask);
      const failures: string[] = [];
      const ctx = { runtime: { dataDir, kitDir: dataDir }, session: { modules: [bank] } as Session,
        progress: { info: () => undefined, ok: () => undefined, fail: (text: string) => failures.push(text) } } as unknown as ActionContext;
      const calls: string[] = [];
      let labelCalls = 0;
      assert.equal(await restartPreservingData(ctx, bank, {
        label: async () => { calls.push('label'); if (!labelCalls++) throw new Error('offline'); return 'lbl1'; },
        restart: async () => { calls.push('stop/start/readiness'); return true; },
      }), true);
      assert.deepEqual(calls, ['label', 'stop/start/readiness', 'label']);
      assert.deepEqual(failures, []);
      if (active) {
        assert.equal(await restartPreservingData(ctx, bank, {
          label: async () => 'foreign', restart: async () => true,
        }), false);
        assert.match(failures[0]!, /Данные сохранены/);
      }
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
}

it('restart не объявляет успех, если stop/start/readiness не выполнен', async () => {
  let reads = 0;
  const ctx = { runtime: { dataDir: '/tmp/kit-no-task-s105', kitDir: '/tmp' }, session: { modules: [bank] },
    progress: { info: () => undefined, ok: () => undefined, fail: () => undefined } } as unknown as ActionContext;
  assert.equal(await restartPreservingData(ctx, bank, { label: async () => { reads += 1; return null; }, restart: async () => false }), false);
  assert.equal(reads, 1);
});

it('stopAll без токена останавливает реальные учебные профили, а не только текущие назначения', async () => {
  const { stopAllOwn, stopAllTargets } = await import('./modules.js');
  const { planAction } = await import('./policy.js');
  const { loadRuntime } = await import('../config.js');
  const stopped: string[] = [];
  const containers = [{ name: 'bank', profile: 'bank', running: true }, { name: 'bank-second', profile: 'bank', running: true }, { name: 'old-module', profile: 'linux', running: true }, { name: 'already-off', profile: 'postgres', running: false }];
  const ctx = { runtime: loadRuntime({ KIT_VERSION: '1' }), progress: { info: () => undefined, ok: () => undefined, fail: () => undefined } } as ActionContext;
  assert.equal(planAction(ctx.runtime, undefined, { action: 'modules.stopAll' }).allowed, true);
  assert.deepEqual(stopAllTargets(undefined, containers).map((module) => module.key), ['bank', 'linux']);
  assert.equal(await stopAllOwn(ctx, { containers: async () => containers, stop: async (module) => { stopped.push(module.profile); return true; } }), true);
  assert.deepEqual(stopped, ['bank', 'linux']);
});
