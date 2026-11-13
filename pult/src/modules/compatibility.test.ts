import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Runtime } from '../config';
import type { Session, SessionModule } from '../platform/types';
import { exactImage, existingLaunch, MIGRATION_REQUIRED, type CompatibilityDeps } from './compatibility';
import { restartModule } from './lifecycle';

const runtime = { version: '0.1.17' } as Runtime;
const linux = { key: 'kit-linux', title: 'Linux', profile: 'linux', allowed: true } as SessionModule;
const session = { kit: { minVersion: '0.1.0' }, modules: [linux] } as Session;
const image = 'ghcr.io/test/linux:0.1.17';
const deps = (current: string | null = image, expected = image): CompatibilityDeps => ({
  containers: async () => [{ name: 'kit-linux', profile: 'linux', running: false }],
  config: async () => ({ services: { linux: { container_name: 'kit-linux', image: expected, profiles: ['linux'] } } }),
  image: async () => current,
});

describe('Linux writable layer', () => {
  it('точный reference разрешает existing start с прежним именем контейнера', async () => {
    assert.deepEqual(await existingLaunch(runtime, linux, deps()), { kind: 'existing', names: ['kit-linux'] });
  });
  for (const current of [null, 'ghcr.io/test/linux:0.1.16']) {
    it(`неизвестный или другой Config.Image (${current}) требует переноса данных`, async () => {
      assert.deepEqual(await existingLaunch(runtime, linux, deps(current)), { kind: 'blocked', reason: MIGRATION_REQUIRED });
    });
  }
  for (const floating of ['ghcr.io/test/linux', 'ghcr.io/test/linux:latest', 'ghcr.io/test/linux:develop']) {
    it(`плавающий reference ${floating} запрещён даже при совпадении`, async () => {
      assert.equal((await existingLaunch(runtime, linux, deps(floating, floating))).kind, 'blocked');
    });
  }
  it('неполный compose/inspect закрывает запуск, отсутствие контейнера разрешает новую установку', async () => {
    assert.equal((await existingLaunch(runtime, linux, { ...deps(), config: async () => null })).kind, 'blocked');
    assert.deepEqual(await existingLaunch(runtime, linux, { ...deps(), containers: async () => [] }), { kind: 'new' });
    assert.equal(exactImage(`linux@sha256:${'a'.repeat(64)}`), true);
  });
  it('restart проверяет совместимость до stop, отказ stop запрещает start', async () => {
    const calls: string[] = [];
    const progress = { info: () => undefined, ok: () => undefined, fail: () => undefined };
    assert.equal(await restartModule(runtime, session, linux, progress, {
      compatible: async () => MIGRATION_REQUIRED,
      stop: async () => { calls.push('stop'); return true; },
      start: async () => { calls.push('start'); return true; },
    }), false);
    assert.equal(calls.length, 0);
    assert.equal(await restartModule(runtime, session, linux, progress, {
      compatible: async () => null,
      stop: async () => { calls.push('stop'); return false; },
      start: async () => { calls.push('start'); return true; },
    }), false);
    assert.deepEqual(calls, ['stop']);
  });
});
