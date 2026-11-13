import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntime } from '../config';
import { Controller } from './controller';
import { bridge, checkCheckout, markPrepared } from './handoff';
import { type Operation } from './types';

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
    writeFileSync(join(dir, 'VERSION'), '1.0.1');
    assert.throws(() => checkCheckout(restart, 'module.restart'), /Версия файлов/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
