import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ProbeError } from './errors';
import type { ProbeContext } from './types';

export const MAX_TEXT_CHARS = 20_000;

export function workPath(ctx: ProbeContext, relative: string): string {
  const root = resolve(ctx.workDir);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new ProbeError(`Путь ${relative} выходит за пределы папки work/`);
  }
  return target;
}

export function readWorkText(ctx: ProbeContext, relative: string): string | null {
  try {
    return readFileSync(workPath(ctx, relative), 'utf8');
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    return null;
  }
}

export function workSize(ctx: ProbeContext, relative: string): number | null {
  try {
    const stat = statSync(workPath(ctx, relative));
    return stat.isFile() ? stat.size : null;
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    return null;
  }
}

export function writeWorkText(ctx: ProbeContext, relative: string, content: string): void {
  const target = workPath(ctx, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

export function missingFile(relative: string): string {
  return `файла work/${relative} нет`;
}

const SKIPPED_DIRS = new Set(['node_modules']);
const MAX_LISTED_FILES = 200;
export const MAX_LISTED_REPORTS = MAX_LISTED_FILES;

export function listWorkFiles(
  ctx: ProbeContext,
  relative: string,
  accept: (path: string) => boolean = () => true,
): { exists: boolean; count: number; files: string[] } {
  const root = workPath(ctx, relative);
  try {
    if (!statSync(root).isDirectory()) return { exists: false, count: 0, files: [] };
  } catch {
    return { exists: false, count: 0, files: [] };
  }
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) visit(join(directory, entry.name), path);
      } else if (entry.isFile() && accept(path)) {
        found.push(path);
      }
    }
  };
  visit(root, '');
  found.sort();
  return { exists: true, count: found.length, files: found.slice(0, MAX_LISTED_FILES) };
}

const DEFAULT_BUNDLE_CHARS = 40_000;
const BUNDLE_SKIPPED_DIRS = new Set(['venv', 'env', '__pycache__', 'target', 'build', 'dist', 'out', 'bin', 'obj', 'reports', 'allure-results', 'allure-report']);
const BUNDLE_SKIPPED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock']);

function bundled(path: string): boolean {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  return !BUNDLE_SKIPPED_FILES.has(name) && !parts.slice(0, -1).some((part) => BUNDLE_SKIPPED_DIRS.has(part));
}

export function bundleWorkFiles(
  ctx: ProbeContext,
  relative: string,
  maxChars = DEFAULT_BUNDLE_CHARS,
): { exists: boolean; files: Array<{ path: string; text: string }>; omitted: number } {
  const listed = listWorkFiles(ctx, relative);
  if (!listed.exists) return { exists: false, files: [], omitted: 0 };
  const files: Array<{ path: string; text: string }> = [];
  let left = maxChars;
  let omitted = 0;
  for (const path of listed.files) {
    if (!bundled(path)) {
      omitted += 1;
      continue;
    }
    const text = readWorkText(ctx, `${relative}/${path}`);
    if (text === null || text.includes('\u0000') || left <= 0) {
      omitted += 1;
      continue;
    }
    const part = text.length > left ? text.slice(0, left) : text;
    files.push({ path, text: part });
    left -= part.length;
  }
  return { exists: true, files, omitted: omitted + (listed.count - listed.files.length) };
}
