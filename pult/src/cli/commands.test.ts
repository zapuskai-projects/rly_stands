import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntime } from '../config';
import { kitFingerprint } from '../panel/store';
import { readConfig, writeConfig } from '../store/stores';
import { UPDATE_EXIT_CODE, runCli } from './commands';

describe('код выхода «обновите набор»', () => {
  it('остаётся 75: на него реагирует скрипт ./stand', () => {
    assert.equal(UPDATE_EXIT_CODE, 75);
  });
});

for (const success of [false, true]) it(`logout возвращает ${success ? 'успех после удаления' : 'ошибку при конфликте и сохраняет токен'}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-logout-'));
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_DATA_DIR: dir, KIT_VERSION: '1.0.0' });
  mkdirSync(join(dir, 'panel'));
  writeFileSync(join(dir, 'panel/controller.json'), JSON.stringify({ fingerprint: kitFingerprint(runtime) }));
  writeFileSync(join(dir, 'panel/internal-key'), 'private-key');
  writeConfig(dir, { token: 'sk_fixture' });
  const output: string[] = [];
  try {
    mock.method(process.stdout, 'write', ((chunk: unknown) => { output.push(String(chunk)); return true; }) as typeof process.stdout.write);
    mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
      const path = new URL(String(input)).pathname;
      if (path === '/internal/meta') return new Response('{}');
      if (path === '/internal/plan') return success
        ? new Response(JSON.stringify({ allowed: true, planId: 'plan', confirmationRequired: true, confirmationToken: 'confirmation' }))
        : new Response(JSON.stringify({ error: { code: 'OPERATION_CONFLICT', message: 'Дождитесь текущего действия' } }), { status: 409 });
      if (path === '/internal/operation') { writeConfig(dir, { token: null }); return new Response(JSON.stringify({ operationId: 'logout' })); }
      return new Response(JSON.stringify({ state: 'SUCCEEDED', events: [], result: { ok: true } }));
    });
    assert.equal(await runCli(runtime, ['logout']), success ? 0 : 1);
    assert.equal(readConfig(dir).token, success ? null : 'sk_fixture');
    assert.equal(output.join('').includes('Токен удалён с этого компьютера'), success);
    if (!success) assert.match(output.join(''), /Дождитесь текущего действия/);
  } finally { mock.restoreAll(); rmSync(dir, { recursive: true, force: true }); }
});
