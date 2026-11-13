import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireWriter } from './mutex';
import { PanelError } from './errors';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('kernel mutex refuses a second writer and releases before the next action', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-mutex-'));
  try {
    const release = await acquireWriter(dir);
    await assert.rejects(acquireWriter(dir), (error) => error instanceof PanelError && error.code === 'WRITER_BUSY');
    await release();
    const next = await acquireWriter(dir); await next();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('writer process death releases the kernel mutex without stale-lock cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-crash-'));
  const program = `import { acquireWriter } from './src/panel/mutex.ts'; await acquireWriter(process.argv[1]); process.stdout.write('HELD\\n'); await new Promise(() => {});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('Writer child failed to start'); })]);
    await assert.rejects(acquireWriter(dir));
    const closed = once(child, 'exit'); child.kill('SIGKILL'); await closed;
    let released = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try { const release = await acquireWriter(dir); await release(); released = true; break; }
      catch (error) { if (!(error instanceof PanelError) || error.code !== 'WRITER_BUSY') throw error; await new Promise((resolve) => setTimeout(resolve, 50)); }
    }
    assert.equal(released, true);
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});
