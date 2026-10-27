import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UPDATE_EXIT_CODE } from './commands';

describe('код выхода «обновите набор»', () => {
  it('остаётся 75: на него реагирует скрипт ./stand', () => {
    assert.equal(UPDATE_EXIT_CODE, 75);
  });
});
