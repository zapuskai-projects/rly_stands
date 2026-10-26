import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(__dirname, '../..');
const SKIP = new Set(['node_modules', '.git', 'dist', '.stand']);
const UNBRACED_BEFORE_NON_ASCII = /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/;

function shellScripts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return shellScripts(path);
    const head = readFileSync(path).subarray(0, 64).toString('utf8');
    return /^#!.*\b(sh|bash)\b/.test(head) ? [path] : [];
  });
}

describe('скрипты оболочки набора', () => {
  it('переменная перед русской буквой или «…» берётся в фигурные скобки: bash 3.2 на Mac с UTF-8 читает такой байт как часть имени', () => {
    const scripts = shellScripts(ROOT);
    assert.ok(scripts.some((path) => relative(ROOT, path) === 'stand'));
    const offenders = scripts.flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => UNBRACED_BEFORE_NON_ASCII.test(line))
        .map(({ index }) => `${relative(ROOT, path)}:${index + 1}`),
    );
    assert.deepEqual(offenders, []);
  });
});
