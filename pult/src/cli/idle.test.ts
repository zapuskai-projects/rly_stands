import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { KitContainer } from '../docker/kit-docker';
import type { Session, SessionModule, SessionTask } from '../platform/types';
import { answerOf, idleQuestion, idleToStop, offerStopIdle } from './idle';

const module = (key: string, requires: string[] = [], withUi = false): SessionModule => ({
  key,
  title: key.replace('kit-', 'Стенд '),
  profile: key.replace('kit-', ''),
  minMemoryMb: 256,
  requires,
  uis: withUi ? [{ title: 'Интернет-банк', url: 'http://localhost:18400' }] : [],
  allowed: true,
  reason: null,
  project: 'zapusk-bank',
});

const task = (modules: string[]): SessionTask => ({
  id: 'l1',
  title: 'Тикет',
  project: { key: 'zapusk-bank', title: 'ЗапускБанк', memberId: 'm1', trackTitle: 'Аналитик', code: 'ZB-101', release: '1.0', state: 'OPEN', current: true, unlocksAfter: null },
  modules: modules.map((key) => ({ key, title: key })),
  status: 'NOT_STARTED',
  attemptId: null,
  label: null,
  needsUpdate: false,
  missingPrimitives: [],
  verifiedOnStand: null,
  verifiedFailureOnStand: null,
});

const session = (): Session => ({
  user: { name: 'Юлия' },
  token: { expiresAt: '2026-11-03T12:00:00Z' },
  kit: { latestVersion: '0.1.0', minVersion: '0.1.0', offlineGraceHours: 24 },
  modules: [module('kit-bank', ['kit-postgres'], true), module('kit-postgres'), module('kit-kafka'), module('kit-rabbitmq')],
  projects: [{ key: 'zapusk-bank', title: 'ЗапускБанк', modules: ['kit-bank', 'kit-postgres', 'kit-kafka', 'kit-rabbitmq'] }],
  tasks: [task([])],
});

const running = (...profiles: string[]): KitContainer[] => profiles.map((profile) => ({ name: `stands-kit-${profile}`, profile, running: true }));

describe('лишние модули при ручном запуске', () => {
  it('лишние — модули проекта, не нужные тикету, которые сейчас работают', () => {
    const idle = idleToStop(session(), [module('kit-kafka')], running('bank', 'postgres', 'kafka', 'rabbitmq'));
    assert.deepEqual(idle.map((item) => item.key), ['kit-rabbitmq']);
  });

  it('запускаемый модуль и его зависимости остановке не подлежат; остановленные в список не попадают', () => {
    const starting = [module('kit-rabbitmq')];
    assert.deepEqual(idleToStop(session(), starting, running('kafka')).map((item) => item.key), ['kit-kafka']);
    assert.deepEqual(idleToStop(session(), starting, []).map((item) => item.key), []);
  });

  it('вопрос называет список и ответ по умолчанию «да»', () => {
    const [kafka, rabbit] = idleToStop(session(), [], running('kafka', 'rabbitmq'));
    assert.equal(idleQuestion([kafka!, rabbit!]), 'Остановить модули, которые не нужны текущей задаче: Стенд kafka, Стенд rabbitmq? [Д/н]');
  });

  it('ответ: Д, y и Enter — да; н, n, Esc и Ctrl+C — нет; прочие клавиши — ждём', () => {
    assert.deepEqual(
      [{ sequence: 'Д' }, { sequence: 'y' }, { name: 'return', sequence: '\r' }].map(answerOf),
      [true, true, true],
    );
    assert.deepEqual(
      [{ sequence: 'н' }, { sequence: 'N' }, { name: 'escape', sequence: '\u001b' }, { name: 'c', ctrl: true, sequence: '\u0003' }].map(answerOf),
      [false, false, false, false],
    );
    assert.deepEqual([{ sequence: 'x' }, { name: 'up', sequence: '\u001b[A' }, {}].map(answerOf), [null, null, null]);
  });

  const offer = (interactive: boolean, answer: boolean, containers: KitContainer[]) => {
    const calls = { asked: [] as string[], stopped: [] as string[] };
    return {
      calls,
      options: {
        session: session(),
        starting: [module('kit-kafka')],
        containers,
        interactive,
        ask: async (question: string) => {
          calls.asked.push(question);
          return answer;
        },
        stop: async (item: SessionModule) => {
          calls.stopped.push(item.key);
          return true;
        },
      },
    };
  };

  it('да — лишние останавливаются; нет — ничего не трогаем', async () => {
    const yes = offer(true, true, running('kafka', 'rabbitmq'));
    assert.deepEqual(await offerStopIdle(yes.options), { asked: true, stopped: ['kit-rabbitmq'] });
    assert.equal(yes.calls.asked.length, 1);
    const no = offer(true, false, running('kafka', 'rabbitmq'));
    assert.deepEqual(await offerStopIdle(no.options), { asked: true, stopped: [] });
    assert.deepEqual(no.calls.stopped, []);
  });

  it('лишних нет — не спрашиваем; без терминала — не спрашиваем и не останавливаем', async () => {
    const none = offer(true, true, running('kafka'));
    assert.deepEqual(await offerStopIdle(none.options), { asked: false, stopped: [] });
    assert.deepEqual(none.calls.asked, []);
    const pipe = offer(false, true, running('kafka', 'rabbitmq'));
    assert.deepEqual(await offerStopIdle(pipe.options), { asked: false, stopped: [] });
    assert.deepEqual([pipe.calls.asked, pipe.calls.stopped], [[], []]);
  });
});
