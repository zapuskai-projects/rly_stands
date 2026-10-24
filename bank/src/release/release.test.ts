import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRelease, parseRelease, releaseAtLeast } from './release';

describe('релизы банка', () => {
  it('релиз доступен, когда текущий не ниже требуемого', () => {
    assert.equal(releaseAtLeast('1.0', '1.0'), true);
    assert.equal(releaseAtLeast('1.0', '1.1'), false);
    assert.equal(releaseAtLeast('1.1', '1.0'), true);
    assert.equal(releaseAtLeast('1.1', '1.2'), false);
    assert.equal(releaseAtLeast('1.2', '1.1'), true);
  });

  it('неизвестный релиз не принимается', () => {
    assert.equal(isRelease('1.1'), true);
    assert.equal(isRelease('2.0'), false);
    assert.equal(isRelease(1.1), false);
    assert.throws(() => parseRelease('9.9', 'тест'), /9\.9/);
  });
});
