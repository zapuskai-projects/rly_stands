import { parse } from 'yaml';
import { errorText } from './errors';
import { asRecord } from './http';
import type { ProbeContext } from './types';
import { missingFile, readWorkText, richTextProblem } from './work';

export type LoadedDocument =
  | { ok: true; text: string; doc: Record<string, unknown> }
  | { ok: false; errors: string[] };

export function parseDocumentText(text: string): LoadedDocument {
  try {
    const value: unknown = parse(text, { prettyErrors: false });
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, errors: ['документ должен быть объектом (YAML или JSON)'] };
    }
    return { ok: true, text, doc: asRecord(value) };
  } catch (error) {
    return { ok: false, errors: [errorText(error).split('\n')[0] ?? 'ошибка разбора'] };
  }
}

export function loadDocument(ctx: ProbeContext, file: string): LoadedDocument {
  const text = readWorkText(ctx, file);
  if (text === null) return { ok: false, errors: [missingFile(file, ctx)] };
  const richText = richTextProblem(text, file);
  return richText ? { ok: false, errors: [richText] } : parseDocumentText(text);
}

export function resolveRef(doc: Record<string, unknown>, node: unknown, depth = 0): unknown {
  const record = asRecord(node);
  const ref = record.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/') || depth > 20) return node;
  let current: unknown = doc;
  for (const segment of ref.slice(2).split('/')) {
    current = asRecord(current)[decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return resolveRef(doc, current, depth + 1);
}

export function refName(node: unknown): string | null {
  const ref = asRecord(node).$ref;
  return typeof ref === 'string' ? (ref.split('/').pop() ?? null) : null;
}
