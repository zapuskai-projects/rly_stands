import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it, mock } from 'node:test';
import type { Runtime } from '../config';
import type { Progress } from '../modules/lifecycle';
import type { Session, SessionTask } from '../platform/types';
import { readCurrentTask, writeConfig } from '../store/stores';
import { restartTaskFlow, startTaskFlow } from './tasks';

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
            seed: [{ action: 'file.write', params: { path: 'seed-state.txt', content: `подготовка ${starts}` } }],
            probes: [],
          }),
        );
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
  });

  function prepare() {
    root = mkdtempSync(join(tmpdir(), 'pult-restart-'));
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'kit', 'work'), { recursive: true });
    writeConfig(join(root, 'data'), { token: 'sk_test', platformUrl: url });
  }

  const seedState = () => readFileSync(join(root, 'kit', 'work', 'seed-state.txt'), 'utf8');

  it('обычный повторный запуск той же попытки сценарий заново не применяет', async () => {
    prepare();
    assert.equal(await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress)), true);
    assert.equal(await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress)), true);
    assert.equal(starts, 2);
    assert.equal(seedState(), 'подготовка 1');
  });

  it('restart применяет сценарий снова, не трогает файлы студента и пишет понятный итог', async () => {
    prepare();
    await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress));
    writeFileSync(join(root, 'kit', 'work', 'my-test.py'), 'работа студента');
    const { progress, lines, failures } = recorder();
    assert.equal(await quietly(() => restartTaskFlow(runtime(), session, progress)), true);
    assert.deepEqual(failures, []);
    assert.equal(seedState(), 'подготовка 2');
    assert.equal(readFileSync(join(root, 'kit', 'work', 'my-test.py'), 'utf8'), 'работа студента');
    assert.equal(lines.at(-1), 'Задача ZB-211 Граничные значения лимита подготовлена заново: сценарий применён. Файлы в work/ не тронуты.');
    assert.equal(readCurrentTask(join(root, 'data'))?.seeded, true);
  });

  it('без текущей задачи restart отказывает и подсказывает, как начать', async () => {
    prepare();
    const { progress, failures } = recorder();
    assert.equal(await quietly(() => restartTaskFlow(runtime(), session, progress)), false);
    assert.match(failures[0] ?? '', /Текущей задачи нет/);
    assert.equal(starts, 0);
  });

  it('платформа недоступна — сценарий не применяется и сообщение понятное', async () => {
    prepare();
    await quietly(() => startTaskFlow(runtime(), session, 'lab-limit', recorder().progress));
    writeConfig(join(root, 'data'), { platformUrl: 'http://127.0.0.1:1' });
    const { progress, failures } = recorder();
    assert.equal(await quietly(() => restartTaskFlow(runtime(), session, progress)), false);
    assert.match(failures[0] ?? '', /Платформа недоступна/);
    assert.equal(seedState(), 'подготовка 1');
  });
});
