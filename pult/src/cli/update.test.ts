import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Runtime } from '../config';
import type { Progress } from '../modules/lifecycle';
import { pullTracker } from '../modules/pull';
import type { StaleService } from '../modules/reconcile';
import { fetchSession } from '../platform/client';
import type { Session } from '../platform/types';
import { readUpdateMarker } from '../store/stores';
import type { SessionContext } from './session';
import {
  belowMinimum,
  needsReconcile,
  NO_NEW_VERSION,
  withUpdateNote,
  newerVersion,
  offerUpdate,
  prepareUpdate,
  pultImageFor,
  refusalReason,
  updateMenuLine,
  updatePlainLine,
  updateQuestion,
  UpdateOffers,
  type PrepareDeps,
} from './update';
import { runUpdateOffer } from './update-flow';

const HOUR = 60 * 60 * 1000;
const runtime = (version = '0.1.11', dataDir = '/tmp/none'): Runtime => ({
  version,
  platformUrl: 'http://127.0.0.1:1',
  dataDir,
  kitDir: '/tmp/none',
  hostDir: '/tmp/none',
  composeFile: '/tmp/none/compose.yaml',
  agentIntervalSec: 600,
  memoryTotalOverrideMb: null,
});

const session = (latestVersion: string, minVersion = '0.1.0'): Session =>
  ({
    user: { name: 'Юлия' },
    token: { expiresAt: '2026-11-03T12:00:00Z' },
    kit: { latestVersion, minVersion, offlineGraceHours: 24 },
    modules: [],
    tasks: [],
  }) as Session;

const ctx = (latestVersion: string, stale = false, minVersion = '0.1.0'): SessionContext => ({
  session: session(latestVersion, minVersion),
  stale,
  staleSince: null,
});

function recorder() {
  const log: string[] = [];
  const progress: Progress = { info: (text) => log.push(`i:${text}`), ok: (text) => log.push(`ok:${text}`), fail: (text) => log.push(`fail:${text}`) };
  return { progress, log };
}

describe('когда предлагать обновление', () => {
  it('предлагает только при более новой версии и свежих данных платформы', () => {
    assert.equal(newerVersion(runtime(), ctx('0.1.12')), '0.1.12');
    assert.equal(newerVersion(runtime(), ctx('0.1.11')), null);
    assert.equal(newerVersion(runtime('0.1.12'), ctx('0.1.11')), null);
    assert.equal(newerVersion(runtime(), ctx('0.1.12', true)), null);
  });

  it('версия ниже минимальной узнаётся отдельно', () => {
    assert.equal(belowMinimum(runtime('0.1.5'), session('0.1.12', '0.1.8')), true);
    assert.equal(belowMinimum(runtime('0.1.8'), session('0.1.12', '0.1.8')), false);
    assert.match(refusalReason(runtime('0.1.5'), session('0.1.12', '0.1.8')), /нужна не ниже 0\.1\.8.*согласитесь обновиться/);
  });

  it('версия ниже минимальной: предлагаем всегда, даже если latestVersion не выше нашей', () => {
    assert.equal(newerVersion(runtime('0.1.5'), ctx('0.1.5', false, '0.1.8')), '0.1.8');
    assert.equal(newerVersion(runtime('0.1.5'), ctx('0.1.12', false, '0.1.8')), '0.1.12');
    assert.equal(newerVersion(runtime('0.1.5'), ctx('0.1.12', true, '0.1.8')), null);
  });

  it('команды, перед которыми догоняем контейнеры', () => {
    for (const command of [undefined, 'start', 'up', 'restart', 'task', 'check', 'verify']) assert.equal(needsReconcile(command), true, String(command));
    for (const command of ['down', 'reset', 'status', 'tasks']) assert.equal(needsReconcile(command), false, command);
  });

  it('причина неудачного обновления не теряется рядом с итогом проверки', () => {
    assert.equal(withUpdateNote('Остаюсь на версии 0.1.11', 'Зачтено'), 'Остаюсь на версии 0.1.11\n Зачтено');
    assert.equal(withUpdateNote(null, 'Зачтено'), 'Зачтено');
  });

  it('тексты для студента', () => {
    assert.match(NO_NEW_VERSION, /новой версии ещё нет/);
    assert.equal(updateMenuLine('0.1.12'), 'Вышла версия 0.1.12. Обновить — клавиша У.');
    assert.equal(updatePlainLine('0.1.12'), 'Вышла версия 0.1.12, обновить: ./stand');
    assert.equal(updateQuestion('0.1.12'), 'Вышла версия 0.1.12. Обновить сейчас? Стенды и ваши файлы останутся. [Д/н]');
  });

  it('отказ запоминается на час', () => {
    const offers = new UpdateOffers();
    assert.equal(offers.canAsk(0), true);
    offers.decline(1000);
    assert.equal(offers.canAsk(1000 + HOUR - 1), false);
    assert.equal(offers.canAsk(1000 + HOUR), true);
  });
});

describe('предложение обновиться', () => {
  const base = () => {
    const said: string[] = [];
    const asked: string[] = [];
    let prepared = 0;
    return {
      said,
      asked,
      prepared: () => prepared,
      deps: (overrides: Partial<Parameters<typeof offerUpdate>[0]> = {}) => ({
        runtime: runtime(),
        ctx: ctx('0.1.12'),
        interactive: true,
        offers: new UpdateOffers(),
        atLaunch: true,
        ask: async (question: string) => {
          asked.push(question);
          return true;
        },
        prepare: async () => {
          prepared += 1;
          return true;
        },
        say: (text: string) => said.push(text),
        now: () => 5000,
        ...overrides,
      }),
    };
  };

  it('согласие: скачивает и просит перезапуск', async () => {
    const t = base();
    assert.equal(await offerUpdate(t.deps()), 'updating');
    assert.deepEqual(t.asked, [updateQuestion('0.1.12')]);
    assert.equal(t.prepared(), 1);
  });

  it('не скачалось: остаёмся на старой версии', async () => {
    const t = base();
    assert.equal(await offerUpdate(t.deps({ prepare: async () => false })), 'failed');
  });

  it('новой версии нет: молчим', async () => {
    const t = base();
    assert.equal(await offerUpdate(t.deps({ ctx: ctx('0.1.11') })), 'none');
    assert.deepEqual(t.asked, []);
    assert.deepEqual(t.said, []);
  });

  it('отказ: не спрашиваем повторно в течение часа, при запуске спрашиваем снова', async () => {
    const t = base();
    const offers = new UpdateOffers();
    assert.equal(await offerUpdate(t.deps({ offers, ask: async () => false })), 'declined');
    assert.equal(await offerUpdate(t.deps({ offers, atLaunch: false, now: () => 5000 + HOUR - 1 })), 'later');
    assert.equal(t.prepared(), 0);
    assert.equal(await offerUpdate(t.deps({ offers, atLaunch: false, now: () => 5000 + HOUR })), 'updating');
    assert.equal(await offerUpdate(t.deps({ offers, atLaunch: true, ask: async () => false, now: () => 6000 })), 'declined');
  });

  it('после неудачной попытки обновления в этом запуске не предлагаем вовсе', async () => {
    const t = base();
    const offers = new UpdateOffers();
    offers.suppressed = true;
    assert.equal(await offerUpdate(t.deps({ offers })), 'none');
    assert.equal(await offerUpdate(t.deps({ offers, interactive: false })), 'none');
    assert.deepEqual([t.asked, t.said], [[], []]);
  });

  it('без терминала не спрашиваем и не обновляем, только строка', async () => {
    const t = base();
    assert.equal(await offerUpdate(t.deps({ interactive: false })), 'plain');
    assert.deepEqual(t.said, ['Вышла версия 0.1.12, обновить: ./stand']);
    assert.deepEqual(t.asked, []);
    assert.equal(t.prepared(), 0);
  });
});

describe('что скачивается перед перезапуском', () => {
  const stale = (image: string): StaleService => ({
    wanted: { service: 'kit-bank-core', container: 'stands-kit-bank-core', image, profiles: ['bank'], dependsOn: [] },
    running: { name: 'stands-kit-bank-core', image: 'bank:0.1.11', profile: 'bank' },
  });

  function deps(overrides: Partial<PrepareDeps> = {}) {
    const pulled: string[] = [];
    const remembered: string[] = [];
    const value: PrepareDeps = {
      pultImage: 'pult:0.1.12',
      stale: async () => [stale('bank:0.1.12')],
      hasImage: async () => false,
      pull: async (image, onLine) => {
        pulled.push(image);
        onLine('a1: Pulling fs layer');
        onLine('a1: Pull complete');
        return 0;
      },
      remember: (version, profiles) => remembered.push(`${version}:${profiles.join(',')}`),
      ...overrides,
    };
    return { value, pulled, remembered };
  }

  it('скачивает пульт и образ банка, потом запоминает согласие', async () => {
    const t = deps();
    const { progress, log } = recorder();
    assert.equal(await prepareUpdate('0.1.12', '0.1.11', progress, t.value), true);
    assert.deepEqual(t.pulled, ['pult:0.1.12', 'bank:0.1.12']);
    assert.deepEqual(t.remembered, ['0.1.12:bank']);
    assert.ok(log.includes('i:  загружено частей: 1 из 1'));
  });

  it('уже скачанное не качает', async () => {
    const t = deps({ hasImage: async (image) => image === 'pult:0.1.12' });
    assert.equal(await prepareUpdate('0.1.12', '0.1.11', recorder().progress, t.value), true);
    assert.deepEqual(t.pulled, ['bank:0.1.12']);
  });

  it('образ закреплён переменной окружения: пульт не качаем', async () => {
    const t = deps({ pultImage: null });
    await prepareUpdate('0.1.12', '0.1.11', recorder().progress, t.value);
    assert.deepEqual(t.pulled, ['bank:0.1.12']);
    assert.equal(pultImageFor('0.1.12', { STAND_PULT_IMAGE: 'my:dev' }), null);
    assert.equal(pultImageFor('0.1.12', {}), 'ghcr.io/zapuskai-projects/stands-kit-pult:0.1.12');
  });

  it('сбой скачивания: согласие не запоминается, стенды остаются на старой версии', async () => {
    const t = deps({ pull: async () => 1 });
    const { progress, log } = recorder();
    assert.equal(await prepareUpdate('0.1.12', '0.1.11', progress, t.value), false);
    assert.deepEqual(t.remembered, []);
    assert.match(log.at(-1) ?? '', /fail:Версия 0\.1\.12 не скачалась.*Остаюсь на версии 0\.1\.11, стенды работают/);
  });

  it('ход загрузки считает слои', () => {
    const seen: string[] = [];
    const feed = pullTracker((text) => seen.push(text));
    for (const line of ['x: Pulling fs layer', 'y: Pulling fs layer', 'x: Download complete', 'x: Pull complete', 'y: Already exists']) feed(line);
    assert.deepEqual(seen, ['  загружено частей: 0 из 1', '  загружено частей: 0 из 2', '  загружено частей: 1 из 2', '  загружено частей: 2 из 2']);
  });
});

describe('предложение по данным поддельной платформы', () => {
  let server: Server;
  let url = '';
  let latest = '0.1.12';
  let dir = '';

  before(async () => {
    server = createServer((request, response) => {
      if (request.url === '/api/stand-kit/session') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(session(latest)));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    dir = mkdtempSync(join(tmpdir(), 'pult-update-'));
  });

  after(async () => {
    rmSync(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function offer(overrides: Record<string, unknown>) {
    const result = await fetchSession(url, 'sk_test', '0.1.11');
    assert.ok(result.ok);
    const said: string[] = [];
    const asked: string[] = [];
    const outcome = await runUpdateOffer({
      runtime: { ...runtime('0.1.11', dir), platformUrl: url },
      ctx: { session: result.session, stale: false, staleSince: null },
      offers: new UpdateOffers(),
      atLaunch: true,
      progress: recorder().progress,
      say: (text) => said.push(text),
      interactive: true,
      ask: async (question) => {
        asked.push(question);
        return true;
      },
      prepare: async () => true,
      ...overrides,
    });
    return { outcome, said, asked };
  }

  it('платформа сообщила новую версию: спрашиваем и соглашаемся', async () => {
    latest = '0.1.12';
    const { outcome, asked } = await offer({});
    assert.equal(outcome, 'updating');
    assert.deepEqual(asked, ['Вышла версия 0.1.12. Обновить сейчас? Стенды и ваши файлы останутся. [Д/н]']);
  });

  it('платформа сообщила ту же версию: тишина', async () => {
    latest = '0.1.11';
    const { outcome, asked, said } = await offer({});
    assert.equal(outcome, 'none');
    assert.deepEqual([asked, said], [[], []]);
  });

  it('без терминала — строка вместо вопроса', async () => {
    latest = '0.1.12';
    const { outcome, said, asked } = await offer({ interactive: false });
    assert.equal(outcome, 'plain');
    assert.deepEqual(said, ['Вышла версия 0.1.12, обновить: ./stand']);
    assert.deepEqual(asked, []);
  });

  it('согласие без скачанного образа маркер не создаёт', () => {
    assert.equal(readUpdateMarker(dir), null);
  });
});
