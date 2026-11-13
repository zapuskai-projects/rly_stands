import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import type { Runtime } from '../config';
import type { Progress } from '../modules/lifecycle';
import type { Session, SessionTask } from '../platform/types';
import { ensureBankSecret, readCurrentTask, writeConfig, writeCurrentTask } from '../store/stores';
import { checkFlow, restartTaskFlow, startTaskFlow } from './tasks';

const task: SessionTask = {
  id: 'lab-limit',
  title: 'Граничные значения лимита',
  project: {
    key: 'zapusk-bank',
    title: 'ЗапускБанк',
    memberId: 'm1',
    trackTitle: 'Тестировщик',
    code: 'ZB-211',
    release: '1.0',
    state: 'OPEN',
    current: true,
    unlocksAfter: null,
  },
  modules: [],
  status: 'STARTED',
  attemptId: 'attempt-1',
  label: 'lbl1',
  needsUpdate: false,
  missingPrimitives: [],
  verifiedOnStand: null,
  verifiedFailureOnStand: null,
};

const session: Session = {
  user: { name: 'Юлия' },
  token: { expiresAt: '2026-11-03T12:00:00Z' },
  kit: { latestVersion: '0.1.0', minVersion: '0.1.0', offlineGraceHours: 24 },
  modules: [],
  tasks: [task],
};

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = process.stdout.write.bind(process.stdout);
  const muted = mock.method(process.stdout, 'write', ((chunk: unknown, ...rest: never[]) =>
    typeof chunk === 'string' ? true : original(chunk as Uint8Array, ...rest)) as typeof process.stdout.write);
  try {
    return await run();
  } finally {
    muted.mock.restore();
  }
}

function recorder() {
  const lines: string[] = [];
  const failures: string[] = [];
  const progress: Progress = { info: (text) => lines.push(text), ok: (text) => lines.push(text), fail: (text) => failures.push(text) };
  return { progress, lines, failures };
}

describe('начать текущую задачу заново', () => {
  let server: Server;
  let url = '';
  let starts = 0;
  let root = '';
  let bank = false;
  let bankLabel: string | null = null;
  let bankStatus = 200;
  let resets = 0;
  let bankWrites = 0;

  const runtime = (): Runtime => ({
    version: '0.1.0',
    platformUrl: url,
    dataDir: join(root, 'data'),
    kitDir: join(root, 'kit'),
    hostDir: join(root, 'kit'),
    composeFile: join(root, 'kit', 'compose.yaml'),
    agentIntervalSec: 600,
    memoryTotalOverrideMb: null,
  });

  before(async () => {
    server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/stand-kit/tasks/lab-limit/start') {
        starts += 1;
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            attemptId: 'attempt-1',
            label: 'lbl1',
            input: 'none',
            title: task.title,
            promptMd: '**Что сделать:** условие',
            hint: null,
            modules: [],
            seed: [...(bank ? [{ action: 'bank.scenario', params: { reset: true } }] : []), { action: 'file.write', params: { path: 'seed-state.txt', content: `подготовка ${starts}` } }],
            probes: [],
          }),
        );
        return;
      }
      if (request.url === '/_kit/scenario' && request.method === 'GET') {
        response.statusCode = bankStatus;
        response.end(JSON.stringify({ label: bankLabel }));
        return;
      }
      if (request.url === '/_kit/reset' && request.method === 'POST') {
        resets += 1;
        bankLabel = null;
        response.end('{}');
        return;
      }
      if (request.url === '/_kit/scenario' && request.method === 'POST') {
        bankWrites += 1;
        bankLabel = 'lbl1';
        response.end('{}');
        return;
      }
      response.statusCode = 404;
      response.end('{"message":"нет"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    starts = 0;
    bank = false;
    bankLabel = null;
    bankStatus = 200;
    resets = 0;
    bankWrites = 0;
    delete process.env.KIT_BANK_URL;
  });

  function prepare() {
    root = mkdtempSync(join(tmpdir(), 'pult-restart-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'kit', 'work'), { recursive: true });
    writeConfig(join(root, 'data'), { token: 'sk_test', platformUrl: url });
    ensureBankSecret(join(root, 'data'));
    process.env.KIT_BANK_URL = `${url}/_kit`;
  }

  const seedState = () => readFileSync(join(root, 'kit', 'work', 'seed-state.txt'), 'utf8');

  it('обычный повторный запуск той же попытки сценарий заново не применяет', async () => {
    prepare();
    assert.equal(await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress)), true);
    assert.equal(await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress)), true);
    assert.equal(starts, 2);
    assert.equal(seedState(), 'подготовка 1');
  });

  it('потеря подготовленного состояния не обнаруживается обычным запуском, restart восстанавливает его', async () => {
    prepare();
    await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress));
    writeFileSync(join(root, 'kit', 'work', 'seed-state.txt'), 'состояние сброшено');
    assert.equal(await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress)), true);
    assert.equal(seedState(), 'состояние сброшено');
    assert.equal(readCurrentTask(join(root, 'data'))?.seeded, true);
    assert.equal(await quietly(() => restartTaskFlow(runtime(), session, recorder().progress, { yes: true })), true);
    assert.equal(seedState(), 'подготовка 3');
  });

  it('restart применяет сценарий снова, не трогает файлы студента и пишет понятный итог', async () => {
    prepare();
    await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress));
    writeFileSync(join(root, 'kit', 'work', 'my-test.py'), 'работа студента');
    const { progress, lines, failures } = recorder();
    assert.equal(await quietly(() => restartTaskFlow(runtime(), session, progress, { yes: true })), true);
    assert.deepEqual(failures, []);
    assert.equal(seedState(), 'подготовка 2');
    assert.equal(readFileSync(join(root, 'kit', 'work', 'my-test.py'), 'utf8'), 'работа студента');
    assert.equal(lines.at(-1), 'Задача ZB-211 Граничные значения лимита подготовлена заново: сценарий применён. Файлы в work/ не тронуты.');
    assert.equal(readCurrentTask(join(root, 'data'))?.seeded, true);
  });

  function prepareBank(label: string | null = 'lbl1') {
    prepare();
    bank = true;
    bankLabel = label;
    writeFileSync(join(root, 'kit', 'work', 'seed-state.txt'), 'работа студента');
  }

  it('совпадение метки продолжает без seed при отсутствующей или потерянной локальной отметке', async () => {
    prepareBank();
    assert.equal(await quietly(() => startTaskFlow(runtime(), session, task.id, recorder().progress)), true);
    const current = readCurrentTask(join(root, 'data'))!;
    assert.equal(current.seeded, true);
    writeCurrentTask(join(root, 'data'), { ...current, seeded: false });
    assert.equal(await quietly(() => startTaskFlow(runtime(), session, task.id, recorder().progress)), true);
    assert.equal(seedState(), 'работа студента');
    assert.equal(resets, 0);
    assert.equal(bankWrites, 0);
  });

  for (const label of [null, 'another-attempt']) {
    it(`потерянная или чужая метка ${String(label)} не сбрасывается молча`, async () => {
      prepareBank();
      await quietly(() => startTaskFlow(runtime(), session, task.id, recorder().progress));
      bankLabel = label;
      const { progress, failures } = recorder();
      assert.equal(await quietly(() => startTaskFlow(runtime(), session, task.id, progress)), false);
      assert.match(failures[0]!, /банк будет сброшен, work/);
      assert.equal(resets, 0);
      assert.equal(bankWrites, 0);
      assert.equal(seedState(), 'работа студента');
    });
  }

  it('чужая метка без локальной записи не стирается даже при новой попытке', async () => {
    prepareBank('another-attempt');
    const fresh = { ...session, tasks: [{ ...task, attemptId: null, status: 'NOT_STARTED' as const }] };
    assert.equal(await quietly(() => startTaskFlow(runtime(), fresh, task.id, recorder().progress)), false);
    assert.equal(resets, 0);
    const questions: string[] = [];
    const ask = async (message: string) => { questions.push(message); return true; };
    assert.equal(await quietly(() => startTaskFlow(runtime(), fresh, task.id, recorder().progress, { ask })), true);
    assert.match(questions[0]!, /переводы.*сброшены.*work/);
    assert.equal(resets, 1);
    assert.equal(bankWrites, 1);
    assert.equal(seedState(), 'работа студента');
  });

  it('первый старт новой задачи готовит пустой банк и сохраняет существующие файлы', async () => {
    prepareBank(null);
    const fresh = { ...session, tasks: [{ ...task, attemptId: null, status: 'NOT_STARTED' as const }] };
    assert.equal(await quietly(() => startTaskFlow(runtime(), fresh, task.id, recorder().progress)), true);
    assert.equal(resets, 1);
    assert.equal(bankWrites, 1);
    assert.equal(seedState(), 'работа студента');
  });

  it('новая задача создаёт отсутствующий стартовый файл в пустом банке', async () => {
    prepareBank(null);
    rmSync(join(root, 'kit', 'work', 'seed-state.txt'));
    const fresh = { ...session, tasks: [{ ...task, attemptId: null, status: 'NOT_STARTED' as const }] };
    assert.equal(await quietly(() => startTaskFlow(runtime(), fresh, task.id, recorder().progress)), true);
    assert.equal(seedState(), 'подготовка 1');
  });

  it('подтверждённое восстановление сохраняет work и применяет сценарий', async () => {
    prepareBank(null);
    assert.equal(await quietly(() => startTaskFlow(runtime(), session, task.id, recorder().progress, { ask: async () => true })), true);
    assert.equal(resets, 1);
    assert.equal(bankWrites, 1);
    assert.equal(seedState(), 'работа студента');
    assert.equal(readCurrentTask(join(root, 'data'))?.seeded, true);
  });

  it('отказ от восстановления сохраняет банк и work', async () => {
    prepareBank('another-attempt');
    assert.equal(await quietly(() => startTaskFlow(runtime(), session, task.id, recorder().progress, { ask: async () => false })), false);
    assert.equal(resets, 0);
    assert.equal(bankWrites, 0);
    assert.equal(bankLabel, 'another-attempt');
    assert.equal(seedState(), 'работа студента');
  });

  it('явный CLI restart банка сохраняет файлы подготовки студента', async () => {
    prepareBank();
    await quietly(() => startTaskFlow(runtime(), session, task.id, recorder().progress));
    assert.equal(await quietly(() => restartTaskFlow(runtime(), session, recorder().progress, { yes: true })), true);
    assert.equal(resets, 1);
    assert.equal(bankWrites, 1);
    assert.equal(seedState(), 'работа студента');
  });

  for (const unavailable of ['404', 'network']) {
    it(`ошибка проверки банка (${unavailable}) запрещает seed и restart`, async () => {
      prepareBank();
      await quietly(() => startTaskFlow(runtime(), session, task.id, recorder().progress));
      bankStatus = 404;
      if (unavailable === 'network') process.env.KIT_BANK_URL = 'http://127.0.0.1:1/_kit';
      assert.equal(await quietly(() => startTaskFlow(runtime(), session, task.id, recorder().progress)), false);
      assert.equal(await quietly(() => restartTaskFlow(runtime(), session, recorder().progress, { yes: true })), false);
      assert.equal(resets, 0);
      assert.equal(bankWrites, 0);
      assert.equal(seedState(), 'работа студента');
    });
  }

  it('check не отправляет факты для чужого сценария или недоступного банка', async () => {
    prepareBank();
    await quietly(() => startTaskFlow(runtime(), session, task.id, recorder().progress));
    const current = readCurrentTask(join(root, 'data'))!;
    writeCurrentTask(join(root, 'data'), { ...current, modules: [{ key: 'kit-bank', title: 'Банк' }] });
    for (const label of [null, 'another-attempt']) {
      bankLabel = label;
      const { progress, failures } = recorder();
      assert.equal(await checkFlow(runtime(), progress, session), null);
      assert.match(failures[0]!, /Проверка не отправлена/);
    }
    bankStatus = 404;
    const { progress, failures } = recorder();
    assert.equal(await checkFlow(runtime(), progress, session), null);
    assert.match(failures[0]!, /Проверка не отправлена/);
    assert.equal(resets, 0);
  });

  it('без текущей задачи restart отказывает и подсказывает, как начать', async () => {
    prepare();
    const { progress, failures } = recorder();
    assert.equal(await quietly(() => restartTaskFlow(runtime(), session, progress, { yes: true })), false);
    assert.match(failures[0] ?? '', /Текущей задачи нет/);
    assert.equal(starts, 0);
  });

  it('платформа недоступна — сценарий не применяется и сообщение понятное', async () => {
    prepare();
    await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress));
    writeConfig(join(root, 'data'), { platformUrl: 'http://127.0.0.1:1' });
    const { progress, failures } = recorder();
    assert.equal(await quietly(() => restartTaskFlow(runtime(), session, progress, { yes: true })), false);
    assert.match(failures[0] ?? '', /Платформа недоступна/);
    assert.equal(seedState(), 'подготовка 1');
  });
});
