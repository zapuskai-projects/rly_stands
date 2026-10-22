import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Runtime } from '../config';
import type { Session, SessionModule } from '../platform/types';
import { startingProfiles } from '../store/starting';
import { composeFailure, startModule } from './lifecycle';

describe('composeFailure', () => {
  it('занятый порт объясняется по-человечески', () => {
    const text = composeFailure(
      ['Error response from daemon: driver failed programming external connectivity: Bind for 127.0.0.1:5672 failed: port is already allocated'],
      1,
    );
    assert.equal(text, 'Порт 5672 занят другой программой или контейнером. Остановите её и запустите стенд снова');
  });

  it('иначе возвращает последнюю строку с ошибкой', () => {
    assert.equal(composeFailure(['Container x Created', 'pull access denied for foo'], 1), 'pull access denied for foo');
  });

  it('без подробностей — код выхода compose', () => {
    assert.equal(composeFailure(['Container x Created'], 17), 'docker compose завершился с ошибкой 17');
  });
});

describe('startModule: метка «запускается»', () => {
  it('после отказа метка снята, у зависимости метки нет', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'kit-lifecycle-'));
    try {
      const runtime = { version: '0.1.0', dataDir } as Runtime;
      const session = { kit: { minVersion: '9.9.9', latestVersion: '9.9.9' } } as Session;
      const bank = { key: 'kit-bank', title: 'ЗапускБанк', profile: 'bank', allowed: true } as SessionModule;
      const messages: string[] = [];
      const progress = { info: () => undefined, ok: () => undefined, fail: (text: string) => void messages.push(text) };
      assert.equal(await startModule(runtime, session, bank, progress), false);
      assert.match(messages[0] ?? '', /устарела/);
      assert.deepEqual(startingProfiles(dataDir), []);
      assert.equal(await startModule(runtime, session, bank, progress, { dependency: true }), false);
      assert.deepEqual(startingProfiles(dataDir), []);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
