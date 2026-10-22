import { executor, type ExecutorTable } from './types';
import {
  bundleWorkFiles,
  listWorkFiles,
  MAX_TEXT_CHARS,
  readWorkText,
  workSize,
  writeWorkText,
} from './work';

export const FILE_EXECUTORS: ExecutorTable = {
  'file.exists': executor<{ path: string }>(async ({ path }, ctx) => {
    const size = workSize(ctx, path);
    return { exists: size !== null, size: size ?? 0 };
  }),

  'file.list': executor<{ dir: string }>(async ({ dir }, ctx) => listWorkFiles(ctx, dir)),

  'file.bundle': executor<{ dir: string; maxChars?: number }>(async ({ dir, maxChars }, ctx) =>
    bundleWorkFiles(ctx, dir, maxChars),
  ),

  'file.content': executor<{ path: string }>(async ({ path }, ctx) => {
    const text = readWorkText(ctx, path);
    if (text === null) return { exists: false, text: '' };
    return { exists: true, text: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text };
  }),

  'file.write': executor<{ path: string; content: string }>(async ({ path, content }, ctx) => {
    writeWorkText(ctx, path, content);
    return { written: true };
  }),
};
