import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROBE_DOCUMENT } from '../testing/release-spec';
import { filterMarkdown } from './doc-filter';

const body = PROBE_DOCUMENT.split('---\n')[2] as string;

describe('разделы документов по релизу', () => {
  it('на 1.0 раздел следующего релиза и его подразделы убраны', () => {
    const text = filterMarkdown(body, '1.0');
    assert.ok(text.includes('## Старый раздел'));
    assert.ok(text.includes('## Последний раздел'));
    assert.equal(text.includes('Только с релиза 1.1'), false);
    assert.equal(text.includes('Подраздел'), false);
    assert.equal(text.includes('{release'), false);
  });

  it('заголовок внутри блока кода не считается разделом', () => {
    const text = filterMarkdown(body, '1.1');
    assert.ok(text.includes('## Не заголовок'));
  });

  it('на 1.1 раздел виден, пометка из заголовка убрана', () => {
    const text = filterMarkdown(body, '1.1');
    assert.ok(text.includes('## Новый раздел\n'));
    assert.ok(text.includes('### Подраздел'));
    assert.equal(text.includes('{release'), false);
  });

  it('релиз-ноты показывают версии до текущей по заголовку', () => {
    const notes = '# Релиз-ноты\n\n## 1.1.0\n\nШаблоны.\n\n## 1.0.0\n\nПервый выпуск.\n';
    const first = filterMarkdown(notes, '1.0', true);
    assert.equal(first.includes('Шаблоны'), false);
    assert.ok(first.includes('## 1.0.0'));
    const second = filterMarkdown(notes, '1.1', true);
    assert.ok(second.includes('## 1.1.0') && second.includes('## 1.0.0'));
  });

  it('заголовок вида «1.1.0» в обычном документе остаётся', () => {
    assert.ok(filterMarkdown('## 1.1.0\n\nТекст', '1.0').includes('## 1.1.0'));
  });
});
