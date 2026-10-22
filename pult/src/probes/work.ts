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

export function listWorkFiles(ctx: ProbeContext, relative: string): { exists: boolean; count: number; files: string[] } {
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
      } else if (entry.isFile()) {
        found.push(path);
      }
    }
  };
  visit(root, '');
  found.sort();
  return { exists: true, count: found.length, files: found.slice(0, MAX_LISTED_FILES) };
}
