import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { reconcileAfterUpdate } from '../cli/update-flow';
import type { Runtime } from '../config';
import { recreateTail, type RunningImage } from '../docker/kit-docker';
import type { Session } from '../platform/types';
import { clearStarting, markStarting } from '../store/starting';
import { readUpdateMarker, writeUpdateMarker } from '../store/stores';
import type { Progress } from './lifecycle';
import {
  CHECK_FAILED,
  composeServices,
  imagesToPull,
  inDependencyOrder,
  recreatedAutomatically,
  reconcileContainers,
  staleServices,
  type ReconcileDeps,
} from './reconcile';

const COMPOSE = {
  services: {
    'kit-agent': { image: 'pult:0.1.12', container_name: 'stands-kit-agent' },
    'kit-bank-sbp': { image: 'bank:0.1.12', container_name: 'stands-kit-bank-sbp', profiles: ['bank'], depends_on: { 'kit-bank-core': {} } },
    'kit-bank-antifraud': { image: 'bank:0.1.12', container_name: 'stands-kit-bank-antifraud', profiles: ['bank'], depends_on: { 'kit-bank-core': {} } },
    'kit-bank-core': { image: 'bank:0.1.12', container_name: 'stands-kit-bank-core', profiles: ['bank'], depends_on: { postgres: {} } },
    'linux-server': { image: 'linux:0.1.12', container_name: 'stands-kit-linux-server', profiles: ['linux'] },
    rabbitmq: { image: 'rabbitmq:3.13', container_name: 'stands-kit-rabbitmq', profiles: ['rabbitmq'] },
    postgres: { image: 'postgres:16', container_name: 'stands-kit-postgres', profiles: ['postgres'] },
  },
};

const RUNNING: RunningImage[] = [
  { name: 'stands-kit-agent', image: 'pult:0.1.12', profile: '' },
  { name: 'stands-kit-bank-core', image: 'bank:0.1.11', profile: 'bank' },
  { name: 'stands-kit-bank-sbp', image: 'bank:0.1.11', profile: 'bank' },
  { name: 'stands-kit-bank-antifraud', image: 'bank:0.1.11', profile: 'bank' },
  { name: 'stands-kit-linux-server', image: 'linux:0.1.11', profile: 'linux' },
  { name: 'stands-kit-rabbitmq', image: 'rabbitmq:3.13', profile: 'rabbitmq' },
  { name: 'stands-kit-postgres', image: 'postgres:16', profile: 'postgres' },
  { name: 'someone-else', image: 'nginx', profile: '' },
];

const session = {
  modules: [
    { key: 'kit-bank', title: 'ЗапускБанк', profile: 'bank', requires: ['kit-postgres'] },
    { key: 'kit-postgres', title: 'PostgreSQL', profile: 'postgres' },
    { key: 'kit-linux', title: 'Linux-сервер', profile: 'linux' },
  ],
} as unknown as Session;

function recorder() {
  const log: string[] = [];
  const progress: Progress = { info: (text) => log.push(text), ok: (text) => log.push(`ok:${text}`), fail: (text) => log.push(`fail:${text}`) };
  return { progress, log };
}

function fakeDeps(overrides: Partial<ReconcileDeps> = {}) {
  const recreated: string[] = [];
  const pulled: string[] = [];
  const readied: string[] = [];
  const deps: ReconcileDeps = {
    listRunning: async () => RUNNING,
    config: async () => COMPOSE,
    hasImage: async () => false,
    pull: async (image, onLine) => {
      pulled.push(image);
      onLine('a: Pulling fs layer');
      onLine('a: Pull complete');
      return 0;
    },
    recreate: async (profiles, service) => {
      recreated.push(`${profiles.join(',')}:${service}`);
      return 0;
    },
    ready: async (profile) => {
      readied.push(profile);
      return true;
    },
    ...overrides,
  };
  return { deps, recreated, pulled, readied };
}

describe('выбор контейнеров к пересозданию', () => {
  it('разбирает сервисы compose: имя контейнера, образ, зависимости', () => {
    const services = composeServices(COMPOSE);
    assert.deepEqual(services.map((item) => item.service), ['kit-agent', 'kit-bank-sbp', 'kit-bank-antifraud', 'kit-bank-core', 'linux-server', 'rabbitmq', 'postgres']);
    assert.deepEqual(services.find((item) => item.service === 'kit-bank-sbp')?.dependsOn, ['kit-bank-core']);
    assert.deepEqual(composeServices(null), []);
  });

  it('отстают только те, у кого образ сменился; чужие контейнеры не трогаются', () => {
    const stale = staleServices(composeServices(COMPOSE), RUNNING);
    assert.deepEqual(stale.map((item) => item.running.name).sort(), ['stands-kit-bank-antifraud', 'stands-kit-bank-core', 'stands-kit-bank-sbp', 'stands-kit-linux-server']);
  });

  it('сами пересоздаём банк и агента, а контейнеры с данными в слое (Linux-сервер) — нет', () => {
    const stale = staleServices(composeServices(COMPOSE), RUNNING);
    assert.deepEqual(stale.filter(recreatedAutomatically).map((item) => item.wanted.service).sort(), ['kit-bank-antifraud', 'kit-bank-core', 'kit-bank-sbp']);
    assert.deepEqual(imagesToPull(stale.filter(recreatedAutomatically)), ['bank:0.1.12']);
  });

  it('сначала ядро банка, потом роли, которые от него зависят', () => {
    const stale = staleServices(composeServices(COMPOSE), RUNNING).filter(recreatedAutomatically);
    assert.equal(inDependencyOrder(stale)[0]?.wanted.service, 'kit-bank-core');
  });

  it('пересоздание не удаляет тома', () => {
    assert.deepEqual(recreateTail('kit-bank-core'), ['up', '-d', '--no-deps', '--force-recreate', 'kit-bank-core']);
  });
});

describe('пересоздание после обновления', () => {
  it('банк по порядку зависимостей, с ходом загрузки и сообщением; Linux-сервер не трогаем, а говорим об этом', async () => {
    const { deps, recreated, pulled } = fakeDeps();
    const { progress, log } = recorder();
    assert.equal(await reconcileContainers(session, '0.1.12', progress, deps), true);
    assert.equal(recreated[0], 'bank:kit-bank-core');
    assert.deepEqual(recreated.slice().sort(), ['bank:kit-bank-antifraud', 'bank:kit-bank-core', 'bank:kit-bank-sbp']);
    assert.deepEqual(pulled, ['bank:0.1.12']);
    assert.ok(log.includes('Linux-сервер обновится, когда вы его перезапустите (данные внутри сбросятся)'));
    assert.ok(log.includes('Скачиваю bank:0.1.12'));
    assert.ok(log.includes('  загружено частей: 1 из 1'));
    assert.ok(log.indexOf('Обновляю банк до 0.1.12, около 20 секунд') > log.indexOf('Скачиваю bank:0.1.12'));
    assert.equal(log.at(-1), 'ok:банк обновлён до 0.1.12, данные на месте');
  });

  it('образ уже скачан: не качаем', async () => {
    const { deps, pulled } = fakeDeps({ hasImage: async () => true });
    await reconcileContainers(session, '0.1.12', recorder().progress, deps);
    assert.deepEqual(pulled, []);
  });

  it('образ не скачался: ничего не пересоздаём', async () => {
    const { deps, recreated } = fakeDeps({ pull: async () => 1 });
    const { progress, log } = recorder();
    assert.equal(await reconcileContainers(session, '0.1.12', progress, deps), false);
    assert.deepEqual(recreated, []);
    assert.ok(log.some((text) => text.startsWith('fail:Образ bank:0.1.12 не скачался')));
  });

  it('служебный агент пересоздаётся без профиля', async () => {
    const { deps, recreated } = fakeDeps({ listRunning: async () => [{ name: 'stands-kit-agent', image: 'pult:0.1.11', profile: '' }] });
    assert.equal(await reconcileContainers(session, '0.1.12', recorder().progress, deps), true);
    assert.deepEqual(recreated, [':kit-agent']);
  });

  it('образы совпали: ничего не делаем и не пишем', async () => {
    const { deps, recreated } = fakeDeps({ listRunning: async () => RUNNING.filter((item) => item.profile !== 'bank' && item.profile !== 'linux') });
    const { progress, log } = recorder();
    assert.equal(await reconcileContainers(session, '0.1.12', progress, deps), true);
    assert.deepEqual([recreated, log], [[], []]);
  });

  it('сбой пересоздания сообщается, остальные продолжаются', async () => {
    const seen: string[] = [];
    const { deps } = fakeDeps({
      recreate: async (_profiles, service) => {
        seen.push(service);
        return service === 'kit-bank-core' ? 1 : 0;
      },
    });
    const { progress, log } = recorder();
    assert.equal(await reconcileContainers(session, '0.1.12', progress, deps), false);
    assert.ok(log.some((text) => text.startsWith('fail:банк: не удалось пересоздать stands-kit-bank-core')));
    assert.equal(seen.length, 3);
  });

  it('банк не пересоздаём, пока не запущены стенды, без которых он не заработает: откладываем и говорим об этом', async () => {
    const { deps, recreated } = fakeDeps({ listRunning: async () => RUNNING.filter((item) => item.profile !== 'postgres') });
    const { progress, log } = recorder();
    assert.equal(await reconcileContainers(session, '0.1.12', progress, deps), false);
    assert.deepEqual(recreated, []);
    assert.ok(log.includes('Обновление отложено (банк): сначала нужно запустить PostgreSQL. Продолжу при следующем запуске ./stand.'));
  });

  it('ошибка Docker — это ошибка, а не «ничего не отстаёт»', async () => {
    for (const broken of [{ listRunning: async () => null }, { config: async () => null }]) {
      const { deps, recreated } = fakeDeps(broken);
      const { progress, log } = recorder();
      assert.equal(await reconcileContainers(session, '0.1.12', progress, deps), false);
      assert.deepEqual(log, [`fail:${CHECK_FAILED}`]);
      assert.deepEqual(recreated, []);
    }
  });
});

describe('согласие на обновление и контейнеры', () => {
  let dir = '';
  const runtime = (version: string): Runtime => ({ version, platformUrl: '', dataDir: dir, kitDir: dir, hostDir: dir, composeFile: '', agentIntervalSec: 600, memoryTotalOverrideMb: null });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function prepare(marker: string | null, profiles: string[] = ['bank']) {
    dir = mkdtempSync(join(tmpdir(), 'pult-reconcile-'));
    if (marker) writeUpdateMarker(dir, marker, profiles);
  }

  it('без согласия (маркера нет) контейнеры не трогаются', async () => {
    prepare(null);
    const { deps, recreated } = fakeDeps();
    assert.equal(await reconcileAfterUpdate(runtime('0.1.12'), session, recorder().progress, deps), true);
    assert.deepEqual(recreated, []);
  });

  it('пока пульт ещё старой версии, маркер сохраняется и контейнеры не трогаются', async () => {
    prepare('0.1.12');
    const { deps, recreated } = fakeDeps();
    await reconcileAfterUpdate(runtime('0.1.11'), session, recorder().progress, deps);
    assert.deepEqual(recreated, []);
    assert.deepEqual(readUpdateMarker(dir), { version: '0.1.12', profiles: ['bank'] });
  });

  it('новый пульт пересоздаёт устаревшие контейнеры и снимает маркер', async () => {
    prepare('0.1.12');
    const { deps, recreated } = fakeDeps();
    assert.equal(await reconcileAfterUpdate(runtime('0.1.12'), session, recorder().progress, deps), true);
    assert.equal(recreated.length, 3);
    assert.equal(readUpdateMarker(dir), null);
  });

  it('при сбое маркер остаётся: попробуем при следующем запуске', async () => {
    prepare('0.1.12');
    const { deps } = fakeDeps({ recreate: async () => 1 });
    assert.equal(await reconcileAfterUpdate(runtime('0.1.12'), session, recorder().progress, deps), false);
    assert.deepEqual(readUpdateMarker(dir), { version: '0.1.12', profiles: ['bank'] });
  });

  it('ошибка Docker не стирает маркер', async () => {
    prepare('0.1.12');
    const { deps } = fakeDeps({ listRunning: async () => null });
    assert.equal(await reconcileAfterUpdate(runtime('0.1.12'), session, recorder().progress, deps), false);
    assert.deepEqual(readUpdateMarker(dir), { version: '0.1.12', profiles: ['bank'] });
  });

  it('повтор после частичного сбоя: пересоздавать нечего, но готовность профилей из маркера ждём и только потом снимаем маркер', async () => {
    prepare('0.1.12');
    const upToDate = RUNNING.map((item) => (item.profile === 'bank' ? { ...item, image: 'bank:0.1.12' } : item)).filter((item) => item.profile !== 'linux');
    const waiting = fakeDeps({ listRunning: async () => upToDate, ready: async () => false });
    assert.equal(await reconcileAfterUpdate(runtime('0.1.12'), session, recorder().progress, waiting.deps), false);
    assert.deepEqual(readUpdateMarker(dir), { version: '0.1.12', profiles: ['bank'] });
    const ready = fakeDeps({ listRunning: async () => upToDate });
    assert.equal(await reconcileAfterUpdate(runtime('0.1.12'), session, recorder().progress, ready.deps), true);
    assert.deepEqual(ready.readied, ['bank']);
    assert.equal(readUpdateMarker(dir), null);
  });

  it('пока что-то запускается, пересоздание откладывается и маркер остаётся', async () => {
    prepare('0.1.12');
    markStarting(dir, 'linux');
    const { deps, recreated } = fakeDeps();
    const { progress, log } = recorder();
    assert.equal(await reconcileAfterUpdate(runtime('0.1.12'), session, progress, deps), false);
    assert.deepEqual(recreated, []);
    assert.equal(log[0], 'Обновление контейнеров отложено: сейчас запускается Linux-сервер. Продолжу при следующем запуске ./stand.');
    assert.deepEqual(readUpdateMarker(dir), { version: '0.1.12', profiles: ['bank'] });
    clearStarting(dir, 'linux');
    assert.equal(await reconcileAfterUpdate(runtime('0.1.12'), session, recorder().progress, deps), true);
  });
});
