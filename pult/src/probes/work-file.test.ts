import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProbeError } from './errors';
import { readWorkFile } from './work-file';

test('отчёт различает отсутствие файла, пустой файл и сохранённый SQL с теми же байтами', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'work-facts-'));
  const ctx = { workDir, hostWorkDir: '/student/kit/work', kitVersion: '0.1.18', label: '' };
  try {
    assert.deepEqual(readWorkFile(ctx, 'report.sql').file, { path: 'report.sql', directory: '/student/kit/work', kitVersion: '0.1.18', exists: false, isFile: false, size: 0, sha256: null, modifiedAt: null });
    writeFileSync(join(workDir, 'report.sql'), '');
    const empty = readWorkFile(ctx, 'report.sql');
    assert.equal(empty.text, '');
    assert.equal(empty.file.exists, true);
    assert.equal(empty.file.size, 0);
    const sql = "SELECT 'отчёт'";
    writeFileSync(join(workDir, 'report.sql'), sql);
    const saved = readWorkFile(ctx, 'report.sql');
    assert.equal(saved.text, sql);
    assert.equal(saved.file.size, Buffer.byteLength(sql));
    assert.equal(saved.file.sha256, createHash('sha256').update(sql).digest('hex'));
    assert.notEqual(saved.file.sha256, empty.file.sha256);
    assert.ok(Number.isFinite(Date.parse(saved.file.modifiedAt!)));
    mkdirSync(join(workDir, 'directory.sql'));
    assert.equal(readWorkFile(ctx, 'directory.sql').file.exists, true);
    assert.equal(readWorkFile(ctx, 'directory.sql').file.isFile, false);
    assert.throws(() => readWorkFile(ctx, '../outside.sql'), ProbeError);
  } finally { rmSync(workDir, { recursive: true, force: true }); }
});
