import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions, isVersion } from './version';

describe('version', () => {
  it('принимает три числа через точку', () => {
    assert.equal(isVersion('0.1.0'), true);
    assert.equal(isVersion('0.1'), false);
    assert.equal(isVersion('v1.0.0'), false);
    assert.equal(isVersion(undefined), false);
  });

  it('сравнивает по числам, а не по строкам', () => {
    assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
    assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
    assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  });
});
