import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { run } from './exec';

describe('run', () => {
  it('нет такой программы — код 127, как в оболочке', async () => {
    const result = await run('kit-no-such-binary', ['--version']);
    assert.equal(result.code, 127);
    assert.match(result.stderr, /not found/);
  });

  it('код выхода программы передаётся как есть', async () => {
    assert.equal((await run('sh', ['-c', 'exit 3'])).code, 3);
    assert.equal((await run('sh', ['-c', 'exit 0'])).code, 0);
  });
});
