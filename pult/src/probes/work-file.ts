import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { ProbeError } from './errors';
import type { ProbeContext } from './types';
import { workPath } from './work';

export type WorkFileFacts = {
  path: string;
  directory: string;
  kitVersion: string | null;
  exists: boolean;
  isFile: boolean;
  size: number;
  sha256: string | null;
  modifiedAt: string | null;
};

export function readWorkFile(ctx: ProbeContext, relative: string): { text: string | null; file: WorkFileFacts } {
  const path = workPath(ctx, relative);
  const location = { path: relative, directory: ctx.hostWorkDir ?? ctx.workDir, kitVersion: ctx.kitVersion ?? null };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return { text: null, file: { ...location, exists: true, isFile: false, size: 0, sha256: null, modifiedAt: stat.mtime.toISOString() } };
    const bytes = readFileSync(descriptor);
    return {
      text: bytes.toString('utf8'),
      file: { ...location, exists: true, isFile: true, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), modifiedAt: stat.mtime.toISOString() },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { text: null, file: { ...location, exists: false, isFile: false, size: 0, sha256: null, modifiedAt: null } };
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(`Не удалось прочитать work/${relative}: ${code ?? 'ошибка чтения'}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
