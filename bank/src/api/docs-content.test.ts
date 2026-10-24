import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { ROOT_DIR } from '../config';
import { readdirSync, readFileSync } from 'node:fs';
import { documentsForRelease, loadDocuments, parseDocument } from './docs-content';

describe('документы банка', () => {
  it('разбирает заголовок, версию и дату из шапки', () => {
    const doc = parseDocument('transfers', '---\ntitle: Переводы\nversion: 1.2.0\nupdated: 2026-10-20\n---\n# Переводы\n\nТекст.\n');
    assert.deepEqual([doc?.title, doc?.version, doc?.updated], ['Переводы', '1.2.0', '2026-10-20']);
    assert.equal(doc?.markdown, '# Переводы\n\nТекст.');
  });

  it('документ без шапки или с неполной шапкой не публикуется', () => {
    assert.equal(parseDocument('a', '# Просто текст'), null);
    assert.equal(parseDocument('a', '---\ntitle: Только заголовок\n---\nтекст'), null);
    assert.equal(parseDocument('a', '---\ntitle: ""\nversion: 1\nupdated: 2026-01-01\n---\n'), null);
  });

  it('все документы из папки docs имеют шапку, релиз-ноты идут последними', () => {
    const documents = loadDocuments(path.join(ROOT_DIR, 'docs'));
    assert.ok(documents.length >= 2);
    assert.equal(documents.at(-1)?.slug, 'release-notes');
    for (const doc of documents) assert.match(doc.version, /^[0-9]+\.[0-9]+\.[0-9]+$/);
  });

  it('номер релиза в шапке читается и как число из YAML', () => {
    assert.equal(parseDocument('a', '---\ntitle: A\nversion: 1.0.0\nupdated: 2026-01-01\nrelease: 1.1\n---\nтекст')?.release, '1.1');
    assert.equal(parseDocument('a', '---\ntitle: A\nversion: 1.0.0\nupdated: 2026-01-01\nrelease: 1.0\n---\nтекст')?.release, '1.0');
    assert.equal(parseDocument('a', '---\ntitle: A\nversion: 1.0.0\nupdated: 2026-01-01\nrelease: 7.7\n---\nтекст'), null);
  });

  it('документ следующего релиза не виден раньше, релиз-ноты и разделы режутся по релизу', () => {
    const source = (slug: string, header: string, text: string) => parseDocument(slug, `---\ntitle: ${slug}\nversion: 1.0.0\nupdated: 2026-01-01\n${header}---\n${text}`) as ReturnType<typeof parseDocument> & object;
    const documents = [
      source('old', '', '# Старый\n\n## Часть {release=1.1}\n\nновое'),
      source('later', 'release: 1.1\n', '# Новый'),
      source('release-notes', '', '# Релиз-ноты\n\n## 1.1.0\n\nновое\n\n## 1.0.0\n\nстарое'),
    ];
    const first = documentsForRelease(documents, '1.0');
    assert.deepEqual(first.map((item) => item.slug), ['old', 'release-notes']);
    assert.equal(first[0]?.markdown.includes('новое'), false);
    assert.equal(first[1]?.markdown.includes('1.1.0'), false);
    const second = documentsForRelease(documents, '1.1');
    assert.deepEqual(second.map((item) => item.slug), ['old', 'later', 'release-notes']);
    assert.ok(second[0]?.markdown.includes('новое'));
    assert.ok(second[2]?.markdown.includes('1.1.0'));
  });

  it('в документах банка нет пометок с неизвестным релизом и ни одна не осталась в тексте для 1.2', () => {
    const directory = path.join(ROOT_DIR, 'docs');
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.md'))) {
      const text = readFileSync(path.join(directory, file), 'utf8');
      for (const [, release] of text.matchAll(/\{release=([^}]*)\}/g)) assert.match(release as string, /^1\.[0-2]$/, file);
    }
    for (const document of documentsForRelease(loadDocuments(directory), '1.2')) assert.equal(document.markdown.includes('{release='), false, document.slug);
  });
});
