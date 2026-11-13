import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Runtime } from '../config';
import type { Session, SessionModule, SessionTask } from '../platform/types';
import { dispatchAction, previewAction } from './dispatcher';
import { planAction } from './policy';

const runtime = { version: '0.1.17', dataDir: '/tmp/s105-unused' } as Runtime;
const postgres = { key: 'kit-postgres', profile: 'postgres', title: 'PostgreSQL', allowed: true } as SessionModule;
const bank = { key: 'kit-bank', profile: 'bank', title: 'Банк', allowed: true, requires: [postgres.key] } as SessionModule;
const task = { id: 'lab1', title: 'Задача', modules: [{ key: bank.key, title: bank.title }] } as SessionTask;
const session = { kit: { minVersion: '0.1.0' }, modules: [postgres, bank], tasks: [task] } as Session;
const progress = { info: () => undefined, ok: () => undefined, fail: () => undefined };

it('dry-run нормализует назначенный target и зависимости без Docker, файлов и сети', () => {
  const request = { action: 'module.start', moduleKey: bank.key } as const;
  assert.deepEqual(previewAction({ runtime, session, progress }, request).targets, [bank.key, postgres.key]);
  assert.equal(planAction(runtime, session, { ...request, moduleKey: 'kit-foreign' }).code, 'MODULE_UNAVAILABLE');
  assert.equal(planAction(runtime, session, { action: 'module.reset', moduleKey: postgres.key }).code, 'SHARED_STORAGE');
});

it('offline не разрешает task/check/update, stop остаётся доступен при старой версии', () => {
  assert.equal(planAction(runtime, session, { action: 'task.start', selector: task.id }, true).code, 'PLATFORM_REQUIRED');
  assert.equal(planAction(runtime, session, { action: 'task.check' }, true).code, 'PLATFORM_REQUIRED');
  assert.equal(planAction({ ...runtime, version: '0.0.0' }, session, { action: 'module.stop', moduleKey: bank.key }).allowed, true);
  assert.equal(planAction({ ...runtime, version: '0.0.0' }, session, { action: 'module.restart', moduleKey: bank.key }).code, 'VERSION_REQUIRED');
});

it('reset и task.restart без явного согласия не исполняются; ask=false сохраняет данные', async () => {
  let steps = 0;
  for (const request of [{ action: 'module.reset', moduleKey: bank.key }, { action: 'task.restart', selector: task.id }] as const) {
    const result = await dispatchAction({ runtime, session, progress, revalidate: async () => ({ session, stale: false }), ask: async () => false, beforeStep: async () => { steps += 1; } }, request);
    assert.equal(result.code, 'CONFIRMATION_REQUIRED');
  }
  assert.equal(steps, 0);
});

it('повторная проверка прав перед действием блокирует отозванное назначение', async () => {
  let steps = 0;
  const result = await dispatchAction({ runtime, session, progress,
    revalidate: async () => ({ session: { ...session, modules: [] }, stale: false }), beforeStep: async () => { steps += 1; } },
  { action: 'module.start', moduleKey: bank.key });
  assert.equal(result.code, 'MODULE_UNAVAILABLE');
  assert.equal(steps, 0);
});

it('preview памяти и неизвестного Docker ничего не запускает и не останавливает', async () => {
  const { inspectActionPlan } = await import('./preview.js');
  const richSession = { ...session, modules: [{ ...postgres, minMemoryMb: 200 }, { ...bank, minMemoryMb: 1000 }] };
  const deps = { containers: async () => [], memory: async () => 500, compatible: async () => null };
  const plan = await inspectActionPlan({ runtime, session: richSession, progress }, { action: 'module.start', moduleKey: bank.key }, deps);
  assert.equal(plan.code, 'MEMORY_REQUIRED');
  const unknown = await inspectActionPlan({ runtime, session: richSession, progress }, { action: 'module.start', moduleKey: bank.key },
    { ...deps, containers: async () => { throw new Error('offline'); } });
  assert.equal(unknown.code, 'DOCKER_UNKNOWN');
});
