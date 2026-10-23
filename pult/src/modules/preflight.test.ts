import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeImages,
  composePorts,
  diskProblem,
  isImageLocal,
  memoryProblem,
  parsePublishedPorts,
  portProblems,
} from './preflight';

const config = {
  services: {
    'bank-api': { profiles: ['bank'], image: 'ghcr.io/zapuskai-projects/stands-kit-bank:0.1.0', ports: [{ published: '18100', target: 8080 }] },
    postgres: { profiles: ['postgres'], image: 'ghcr.io/zapuskai-projects/mirror/postgres:16.15', ports: [{ published: 15432, target: 5432 }] },
    kibana: { profiles: ['elastic'], image: 'ghcr.io/zapuskai-projects/mirror/kibana:8.15.3', ports: [{ published: '5601' }] },
    tools: { image: 'busybox' },
  },
};

describe('preflight', () => {
  it('память: сумма модулей проекта с запасом против памяти Docker', () => {
    const modules = [
      { title: 'Банк', minMemoryMb: 1024 },
      { title: 'PostgreSQL', minMemoryMb: 512 },
    ];
    assert.equal(memoryProblem(4096, modules), null);
    assert.match(memoryProblem(1536, modules) ?? '', /нужно 1,7 ГБ памяти Docker, отдано 1,5 ГБ/);
    assert.equal(memoryProblem(null, modules), null);
  });

  it('диск: на каждый недостающий образ — запас, один новый образ не требует места на весь проект', () => {
    assert.equal(diskProblem(3000, 0), null);
    assert.equal(diskProblem(3000, 1), null);
    assert.match(diskProblem(3000, 9) ?? '', /чтобы скачать образы проекта нужно около 7,2 ГБ/);
    assert.match(diskProblem(500, 0) ?? '', /для данных стендов/);
    assert.equal(diskProblem(null, 9), null);
  });

  it('образы и порты — только поднимаемых профилей', () => {
    assert.deepEqual(composeImages(config, ['bank', 'postgres']), [
      'ghcr.io/zapuskai-projects/stands-kit-bank:0.1.0',
      'ghcr.io/zapuskai-projects/mirror/postgres:16.15',
    ]);
    assert.deepEqual(composePorts(config, ['bank', 'postgres']), [
      { port: 18100, profile: 'bank' },
      { port: 15432, profile: 'postgres' },
    ]);
    assert.deepEqual(composePorts(null, ['bank']), []);
  });

  it('порты своих контейнеров не считаются занятыми', () => {
    assert.deepEqual(
      [...parsePublishedPorts('127.0.0.1:15432->5432/tcp\n127.0.0.1:5672->5672/tcp, 127.0.0.1:15672->15672/tcp\n')],
      [15432, 5672, 15672],
    );
  });

  it('занятый порт — строка с именем стенда и тем, что сделать', () => {
    const problems = portProblems(
      [
        { port: 15432, profile: 'postgres' },
        { port: 18100, profile: 'bank' },
      ],
      new Set([15432]),
      new Map([['postgres', 'PostgreSQL']]),
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /Порт 15432 занят другой программой, а он нужен стенду «PostgreSQL»/);
    assert.match(problems[0]!, /lsof -i :15432/);
  });

  it('образ без тега — это latest, docker.io и library — то же имя', () => {
    assert.equal(isImageLocal('busybox', new Set(['busybox:latest'])), true);
    assert.equal(isImageLocal('docker.io/postgres:16.15', new Set(['postgres:16.15'])), true);
    assert.equal(isImageLocal('docker.io/redpandadata/redpanda:v24.2.4', new Set(['redpandadata/redpanda:v24.2.4'])), true);
    assert.equal(isImageLocal('localhost:5000/bank', new Set(['localhost:5000/bank:latest'])), true);
    assert.equal(isImageLocal('postgres:16.15', new Set(['postgres:16.14'])), false);
  });
});
