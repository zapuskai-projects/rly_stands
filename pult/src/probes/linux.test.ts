import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDiskPercent, parseServices, parseStat } from './linux';

describe('разбор вывода Linux-сервера', () => {
  it('статусы supervisord', () => {
    const output = 'app                              RUNNING   pid 12, uptime 0:01:10\nnginx                            FATAL     Exited too quickly\nsshd                             STOPPED   Not started';
    assert.deepEqual(parseServices(output), [
      { name: 'app', state: 'RUNNING' },
      { name: 'nginx', state: 'FATAL' },
      { name: 'sshd', state: 'STOPPED' },
    ]);
  });

  it('права, владелец и размер файла', () => {
    assert.deepEqual(parseStat('664|root|student|120\n'), { exists: true, mode: '664', owner: 'root', group: 'student', size: 120 });
  });

  it('занятое место раздела', () => {
    const output = 'Filesystem     1024-blocks   Used Available Capacity Mounted on\ntmpfs               32768  32768         0     100% /var/log/app';
    assert.equal(parseDiskPercent(output), 100);
    assert.equal(parseDiskPercent(''), null);
  });
});
