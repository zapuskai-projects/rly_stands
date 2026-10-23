import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session, SessionTask } from '../platform/types';
import { currentTicket, idleModules, mainModule, projectModules, startupModules, ticketNeedsStart, ticketUrl } from './start';

const module = (key: string, project: string | null = 'zapusk-bank', requires: string[] = []) => ({
  key,
  title: key,
  profile: key.replace('kit-', ''),
  minMemoryMb: 256,
  requires,
  uis: [],
  allowed: true,
  reason: null,
  project,
});

function ticket(
  id: string,
  code: string,
  state: 'DONE' | 'OPEN' | 'LOCKED',
  current: boolean,
  modules: string[] = [],
): SessionTask {
  return {
    id,
    title: `Тикет ${code}`,
    project: {
      key: 'zapusk-bank',
      title: 'ЗапускБанк',
      memberId: 'm1',
      trackTitle: 'Аналитик',
      code,
      release: 'r1',
      state,
      current,
      unlocksAfter: null,
    },
    modules: modules.map((key) => ({ key, title: key })),
    status: state === 'DONE' ? 'PASSED' : 'NOT_STARTED',
    attemptId: null,
    label: null,
    needsUpdate: false,
    missingPrimitives: [],
    verifiedOnStand: null,
    verifiedFailureOnStand: null,
  };
}

const session = (overrides: Partial<Session> = {}): Session => ({
  user: { name: 'Юлия' },
  webUrl: 'https://edu.example.com/',
  token: { expiresAt: '2026-11-03T12:00:00Z' },
  kit: { latestVersion: '0.1.0', minVersion: '0.1.0', offlineGraceHours: 24 },
  modules: [module('kit-bank'), module('kit-postgres'), module('kit-rabbitmq', null)],
  projects: [{ key: 'zapusk-bank', title: 'ЗапускБанк', modules: ['kit-bank', 'kit-postgres'] }],
  tasks: [ticket('l0', 'ZB-100', 'DONE', false), ticket('l1', 'ZB-101', 'OPEN', true), ticket('l2', 'ZB-102', 'LOCKED', false)],
  ...overrides,
});

describe('подъём проекта', () => {
  it('поднимает только окружение проекта', () => {
    assert.deepEqual(
      projectModules(session()).map((item) => item.key),
      ['kit-bank', 'kit-postgres'],
    );
    assert.deepEqual(projectModules(session({ projects: [], modules: [module('kit-rabbitmq', null)] })), []);
  });

  it('текущий тикет — открытый и отмеченный текущим', () => {
    assert.equal(currentTicket(session())?.project?.code, 'ZB-101');
    assert.equal(currentTicket(session({ tasks: [ticket('l0', 'ZB-100', 'DONE', false)] })), null);
  });

  it('ссылка на страницу тикета — от адреса сайта платформы', () => {
    const value = session();
    assert.equal(ticketUrl(value, value.tasks[1]!), 'https://edu.example.com/student/labs/l1');
    assert.equal(ticketUrl(session({ webUrl: null }), value.tasks[1]!), null);
  });

  it('начатый тикет не готовится заново', () => {
    const value = session().tasks[1]!;
    assert.equal(ticketNeedsStart(value, null), true);
    assert.equal(ticketNeedsStart(value, 'l0'), true);
    assert.equal(ticketNeedsStart(value, 'l1'), false);
    assert.equal(ticketNeedsStart({ ...value, status: 'PASSED' }, null), false);
  });

  it('главный экран — первый модуль окружения с адресом, а не панель зависимости', () => {
    const bank = { ...module('kit-bank'), uis: [{ title: 'Интернет-банк', url: 'http://localhost:18400' }] };
    const rabbit = { ...module('kit-rabbitmq'), uis: [{ title: 'Панель RabbitMQ', url: 'http://localhost:15672' }] };
    assert.equal(mainModule([module('kit-postgres'), bank, rabbit])?.key, 'kit-bank');
    assert.equal(mainModule([module('kit-postgres')]), null);
  });

  describe('что поднимает ./stand start', () => {
    const withUi = (key: string, requires: string[] = []) => ({
      ...module(key, 'zapusk-bank', requires),
      uis: [{ title: key, url: `http://localhost/${key}` }],
    });
    const environment = [
      withUi('kit-bank', ['kit-postgres', 'kit-kafka']),
      module('kit-clickhouse'),
      module('kit-camunda', 'zapusk-bank', ['kit-postgres']),
      module('kit-kafka'),
      module('kit-postgres'),
    ];
    const project = {
      key: 'zapusk-bank',
      title: 'ЗапускБанк',
      modules: environment.map((item) => item.key),
    };
    const keys = (value: Session) => startupModules(value).map((item) => item.key);

    it('банк с зависимостями и модули текущего тикета, остальное окружение не трогает', () => {
      const value = session({
        modules: environment,
        projects: [project],
        tasks: [ticket('l1', 'ZB-130', 'OPEN', true, ['kit-bank', 'kit-clickhouse'])],
      });
      assert.deepEqual(keys(value), ['kit-bank', 'kit-clickhouse', 'kit-kafka', 'kit-postgres']);
    });

    it('модуль следующего тикета подходит, когда тикет становится текущим', () => {
      const tasks = [
        ticket('l1', 'ZB-130', 'DONE', false, ['kit-bank', 'kit-clickhouse']),
        ticket('l2', 'ZB-133', 'OPEN', true, ['kit-bank', 'kit-camunda']),
      ];
      assert.deepEqual(keys(session({ modules: environment, projects: [project], tasks })), [
        'kit-bank',
        'kit-camunda',
        'kit-kafka',
        'kit-postgres',
      ]);
    });

    it('зависимость модуля тикета подтягивается, даже если тикет её не назвал', () => {
      const tasks = [ticket('l2', 'ZB-133', 'OPEN', true, ['kit-camunda'])];
      assert.deepEqual(keys(session({ modules: environment, projects: [project], tasks })), [
        'kit-bank',
        'kit-camunda',
        'kit-kafka',
        'kit-postgres',
      ]);
    });

    it('все тикеты сданы — поднимается только банк с зависимостями', () => {
      const tasks = [ticket('l1', 'ZB-130', 'DONE', false, ['kit-bank', 'kit-clickhouse'])];
      assert.deepEqual(keys(session({ modules: environment, projects: [project], tasks })), [
        'kit-bank',
        'kit-kafka',
        'kit-postgres',
      ]);
    });

    it('модуль тикета вне окружения проекта не поднимается', () => {
      const outside = [...environment, module('kit-linux', null)];
      const tasks = [ticket('l1', 'ZB-130', 'OPEN', true, ['kit-bank', 'kit-linux'])];
      assert.equal(keys(session({ modules: outside, projects: [project], tasks })).includes('kit-linux'), false);
    });

    it('лишним считается модуль прошлого тикета, а не зависимость банка', () => {
      const tasks = [
        ticket('l1', 'ZB-130', 'DONE', false, ['kit-bank', 'kit-clickhouse']),
        ticket('l2', 'ZB-133', 'OPEN', true, ['kit-bank', 'kit-camunda']),
      ];
      const value = session({ modules: environment, projects: [project], tasks });
      assert.deepEqual(
        idleModules(value).map((item) => item.key),
        ['kit-clickhouse'],
      );
    });

    it('при тикете с ClickHouse лишней оказывается Camunda', () => {
      const tasks = [ticket('l1', 'ZB-130', 'OPEN', true, ['kit-bank', 'kit-clickhouse'])];
      assert.deepEqual(
        idleModules(session({ modules: environment, projects: [project], tasks })).map((item) => item.key),
        ['kit-camunda'],
      );
    });

    it('без модуля с адресом и без модулей тикета остаётся всё окружение проекта', () => {
      const bare = [module('kit-kafka'), module('kit-postgres')];
      const value = session({
        modules: bare,
        projects: [{ ...project, modules: ['kit-kafka', 'kit-postgres'] }],
        tasks: [],
      });
      assert.deepEqual(keys(value), ['kit-kafka', 'kit-postgres']);
    });
  });
});
