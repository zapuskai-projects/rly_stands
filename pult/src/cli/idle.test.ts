import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import type { KitContainer } from '../docker/kit-docker';
import type { Session, SessionModule, SessionTask } from '../platform/types';
import { answerOf, askYesNo, idleQuestion, idleToStop, offerStopIdle, type AnswerKey } from './idle';

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

describe('вопрос с клавишей', () => {
  function fakeInput() {
    const emitter = new EventEmitter();
    const modes: boolean[] = [];
    const input = {
      isRaw: false,
      on: (event: 'keypress', handler: (chunk: string, key: AnswerKey) => void) => emitter.on(event, handler),
      off: (event: 'keypress', handler: (chunk: string, key: AnswerKey) => void) => emitter.off(event, handler),
      setRawMode: (mode: boolean) => modes.push(mode),
      resume: () => undefined,
    };
    return { input, press: (key: AnswerKey) => emitter.emit('keypress', '', key), modes, listeners: () => emitter.listenerCount('keypress') };
  }

  it('Ctrl+C на вопросе об обновлении завершает пульт, а не считается ответом «нет»', async () => {
    const { input, press, listeners } = fakeInput();
    let interrupted = 0;
    let answered: boolean | null = null;
    void askYesNo('Обновить?', { input, out: () => undefined, onInterrupt: () => (interrupted += 1) }).then((value) => (answered = value));
    press({ ctrl: true, name: 'c' });
    await Promise.resolve();
    assert.equal(interrupted, 1);
    assert.equal(answered, null);
    assert.equal(listeners(), 0);
  });

  it('Ctrl+C без обработчика остаётся ответом «нет», как у вопроса про лишние модули', async () => {
    const { input, press } = fakeInput();
    const answer = askYesNo('Остановить?', { input, out: () => undefined });
    press({ ctrl: true, name: 'c' });
    assert.equal(await answer, false);
  });

  it('клавиши в первые мгновения не считаются ответом: случайный Enter при загрузке не станет «да»', async () => {
    const { input, press } = fakeInput();
    let now = 1000;
    const answer = askYesNo('Обновить?', { input, out: () => undefined, settleMs: 700, now: () => now });
    press({ name: 'return' });
    now += 699;
    press({ name: 'return' });
    now += 1;
    press({ name: 'return' });
    assert.equal(await answer, true);
  });

  it('отказ после паузы — «нет»', async () => {
    const { input, press } = fakeInput();
    let now = 0;
    const answer = askYesNo('Обновить?', { input, out: () => undefined, settleMs: 700, now: () => now });
    now = 800;
    press({ sequence: 'н' });
    assert.equal(await answer, false);
  });
});
