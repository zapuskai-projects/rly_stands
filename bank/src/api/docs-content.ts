import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { parse } from 'yaml';
import { z } from 'zod';

const frontMatterSchema = z.object({
  title: z.string().min(1),
  version: z.string().min(1),
  updated: z.union([z.string(), z.date()]).transform((value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value)),
});

export interface DocumentMeta {
  slug: string;
  title: string;
  version: string;
  updated: string;
}

export interface BankDocument extends DocumentMeta {
  markdown: string;
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SLUG = /^[a-z0-9-]+$/;

export function parseDocument(slug: string, source: string): BankDocument | null {
  const match = FRONT_MATTER.exec(source);
  if (!match) return null;
  const meta = frontMatterSchema.safeParse(parse(match[1] as string));
  if (!meta.success) return null;
  return { slug, ...meta.data, markdown: source.slice(match[0].length).trim() };
}

export function loadDocuments(directory: string): BankDocument[] {
  const documents: BankDocument[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.md')).sort()) {
    const slug = file.slice(0, -3);
    if (!SLUG.test(slug)) continue;
    const parsed = parseDocument(slug, readFileSync(path.join(directory, file), 'utf8'));
    if (parsed) documents.push(parsed);
  }
  return documents.sort((a, b) => (a.slug === 'release-notes' ? 1 : b.slug === 'release-notes' ? -1 : a.title.localeCompare(b.title, 'ru')));
}

function specVersion(file: string): string {
  const info = (parse(readFileSync(file, 'utf8')) as { info?: { version?: string } }).info;
  return info?.version ?? '1.0.0';
}

export function mountDocsContent(app: Express, directory: string): void {
  app.get('/docs-content', (_req: Request, res: Response) => {
    const specs = [
      { id: 'openapi', title: 'Контракт API (OpenAPI)', version: specVersion(path.join(directory, 'openapi.yaml')), href: '/api/docs', rawHref: '/api/openapi.yaml' },
      { id: 'asyncapi', title: 'События (AsyncAPI)', version: specVersion(path.join(directory, 'asyncapi.yaml')), href: '/api/asyncapi.yaml', rawHref: '/api/asyncapi.yaml' },
    ];
    res.json({ documents: loadDocuments(directory).map(({ slug, title, version, updated }) => ({ slug, title, version, updated })), specs });
  });
  app.get('/docs-content/:slug', (req: Request, res: Response) => {
    const slug = String(req.params.slug);
    const document = SLUG.test(slug) ? loadDocuments(directory).find((item) => item.slug === slug) : undefined;
    if (!document) {
      res.status(404).json({ code: 'DOCUMENT_NOT_FOUND', message: 'Документ не найден' });
      return;
    }
    res.json(document);
  });
  app.get('/api/asyncapi.yaml', (_req: Request, res: Response) => {
    res.type('text/yaml; charset=utf-8').send(readFileSync(path.join(directory, 'asyncapi.yaml'), 'utf8'));
  });
}
