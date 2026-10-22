import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import path from 'node:path';
import { ROOT_DIR } from '../config';
import { loadDocuments, parseDocument } from './docs-content';

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
});
