import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canResumeRelease, nextVersion } from './release.mjs';

describe('автоматический выпуск', () => {
  it('использует уже подготовленную новую версию', () => {
    assert.equal(nextVersion('0.1.18', ['v0.1.17']), '0.1.18');
    assert.equal(nextVersion('0.1.18', []), '0.1.18');
  });

  it('поднимает patch без ручного изменения VERSION', () => {
    assert.equal(nextVersion('0.1.18', ['v0.1.18']), '0.1.19');
    assert.equal(nextVersion('0.1.18', ['v0.1.9', 'v0.1.19', 'v0.1.18']), '0.1.20');
  });

  it('игнорирует прочие теги и отказывается выпускать некорректную версию', () => {
    assert.equal(nextVersion('0.1.18', ['v0.1.18-rc1', 'test', 'v0.1.17']), '0.1.18');
    assert.throws(() => nextVersion('latest', []));
    assert.throws(() => nextVersion('1.0.9999', ['v1.0.9999']));
  });

  const published = {
    source: 'source', parent: 'source', head: 'release', tag: 'release',
    subject: 'chore(kit): release 0.1.18', version: '0.1.18',
    files: ['VERSION', 'pult/package.json', 'pult/package-lock.json'],
  };

  it('позволяет повторить объявление после публикации тега', () => {
    assert.equal(canResumeRelease(published), true);
    assert.equal(canResumeRelease({ ...published, files: [] }), true);
  });

  it('не выпускает старую сборку поверх нового main', () => {
    assert.equal(canResumeRelease({ ...published, parent: 'new-source' }), false);
    assert.equal(canResumeRelease({ ...published, tag: 'other' }), false);
    assert.equal(canResumeRelease({ ...published, files: ['pult/src/main.ts'] }), false);
  });
});
