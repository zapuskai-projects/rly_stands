import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Runtime } from '../config';
import type { Session } from '../platform/types';
import { shouldSelfUpdate } from './commands';
import type { SessionContext } from './session';

const runtime = { version: '0.1.0' } as Runtime;
const ctx = (latestVersion: string, stale = false): SessionContext => ({
  session: {
    user: { name: 'Юлия' },
    token: { expiresAt: '2026-11-03T12:00:00Z' },
    kit: { latestVersion, minVersion: '0.1.0', offlineGraceHours: 24 },
    modules: [],
    tasks: [],
  } as Session,
  stale,
  staleSince: null,
});

describe('самообновление', () => {
  const env = { STAND_SELF_UPDATE: '1' };

  it('просит обновиться, когда на платформе версия новее', () => {
    assert.equal(shouldSelfUpdate(runtime, ctx('0.2.0'), env), true);
    assert.equal(shouldSelfUpdate(runtime, ctx('0.1.0'), env), false);
  });

  it('не зацикливается и не мешает старому скрипту и работе без связи', () => {
    assert.equal(shouldSelfUpdate(runtime, ctx('0.2.0'), { ...env, STAND_UPDATED: '1' }), false);
    assert.equal(shouldSelfUpdate(runtime, ctx('0.2.0'), {}), false);
    assert.equal(shouldSelfUpdate(runtime, ctx('0.2.0', true), env), false);
  });
});
