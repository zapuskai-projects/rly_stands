import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Readiness } from './readiness';

describe('готовность роли банка', () => {
  it('без частей готова; пока хоть одна часть не готова, называет её', () => {
    const readiness = new Readiness();
    assert.equal(readiness.isReady(), true);
    let consumer = false;
    readiness.add('потребитель', () => consumer);
    readiness.add('производитель', () => true);
    assert.equal(readiness.isReady(), false);
    assert.deepEqual(readiness.pending(), ['потребитель']);
    consumer = true;
    assert.equal(readiness.isReady(), true);
    assert.deepEqual(readiness.pending(), []);
  });
});
