import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntime } from '../config';
import { decodeWorkBytes, listWork, readWork, saveWork } from './work';
import { PanelError } from './errors';

test('UTF-8 text is complete and binary/oversized content cannot become an editable prefix', () => {
  const text = 'Русский текст 🙂\n'.repeat(10000);
  assert.equal(decodeWorkBytes(Buffer.from(text)), text);
  assert.throws(() => decodeWorkBytes(Buffer.from([0xff, 0xfe])));
  assert.throws(() => decodeWorkBytes(Buffer.from([65, 0, 66])));
  assert.throws(() => decodeWorkBytes(Buffer.alloc(1024 * 1024 + 1, 65)), (error) => error instanceof PanelError && error.code === 'WORK_TOO_LARGE');
});

test('unsafe paths are rejected before touching the filesystem', () => {
  const runtime = loadRuntime({ KIT_DIR: '/nonexistent' });
  for (const path of ['../secret', '/etc/passwd', 'dir/../../secret', 'a\0b', '.hidden/file', 'node_modules/file', 'dir\\file', 'a//b']) assert.throws(() => readWork(runtime, path), (error) => error instanceof PanelError && error.code === 'WORK_PATH');
});

test('work saves use CAS and preserve ownership, or fail closed outside the container runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'panel-work-'));
  const runtime = loadRuntime({ KIT_DIR: dir, KIT_HOST_DIR: '/host/path with spaces' });
  mkdirSync(join(dir, 'work')); const path = join(dir, 'work/answer.txt'); writeFileSync(path, 'original', { mode: 0o664 });
  try {
    if (process.platform !== 'linux') {
      assert.throws(() => readWork(runtime, 'answer.txt'), (error) => error instanceof PanelError && error.code === 'WORK_RUNTIME');
      assert.throws(() => saveWork(runtime, 'answer.txt', 'mine', '"old"')); assert.equal(readFileSync(path, 'utf8'), 'original'); return;
    }
    const before = statSync(path); const file = readWork(runtime, 'answer.txt');
    assert.equal(file.hostPath, '/host/path with spaces/work/answer.txt');
    writeFileSync(path, 'external');
    assert.throws(() => saveWork(runtime, 'answer.txt', 'mine', file.etag), (error) => error instanceof PanelError && error.status === 412);
    assert.equal(readFileSync(path, 'utf8'), 'external');
    const fresh = readWork(runtime, 'answer.txt'); saveWork(runtime, 'answer.txt', 'mine', fresh.etag);
    const after = statSync(path); assert.equal(after.mode, before.mode); assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid); assert.equal(readFileSync(path, 'utf8'), 'mine');
    symlinkSync('/etc/passwd', join(dir, 'work/link')); assert.throws(() => readWork(runtime, 'link'));
    assert.equal(listWork(runtime).total, 1);
    symlinkSync('/tmp', join(dir, 'work/outside')); assert.throws(() => readWork(runtime, 'outside/anything'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
