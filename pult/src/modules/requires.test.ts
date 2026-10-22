import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session, SessionModule } from '../platform/types';
import { buildRows } from './view';
import { isRequiredByRunning, requiredModules, requirerOf } from './requires';

const base: SessionModule = {
  key: 'kit-postgres',
  title: 'PostgreSQL',
  profile: 'postgres',
  minMemoryMb: 300,
  uis: [],
  allowed: false,
  reason: 'не назначен',
};
const kafka: SessionModule = { ...base, key: 'kit-kafka', title: 'Kafka', profile: 'kafka' };
const bank: SessionModule = {
  ...base,
  key: 'kit-bank',
  title: 'ЗапускБанк',
  profile: 'bank',
  minMemoryMb: 2048,
  allowed: true,
  reason: null,
  requires: ['kit-postgres', 'kit-kafka', 'kit-ghost'],
};

const session = (modules: SessionModule[]): Session => ({
  user: { name: 'Юлия' },
  token: { expiresAt: '2026-11-03T12:00:00Z' },
  kit: { latestVersion: '0.1.0', minVersion: '0.1.0', offlineGraceHours: 24 },
  modules,
  tasks: [],
});

describe('зависимости модулей из сессии', () => {
  it('находит нужные стенды по ключам, даже не назначенные; пропавшие — отдельно', () => {
    const result = requiredModules(session([base, kafka, bank]), bank);
    assert.deepEqual(result.modules.map((item) => item.key), ['kit-postgres', 'kit-kafka']);
    assert.deepEqual(result.missing, ['kit-ghost']);
  });

  it('без requires зависимостей нет', () => {
    assert.deepEqual(requiredModules(session([base]), base), { modules: [], missing: [] });
  });

  it('стенд нужен, пока работает назначенный модуль, которому он требуется', () => {
    const all = session([base, kafka, bank]);
    assert.equal(isRequiredByRunning(all, base, ['postgres', 'bank']), true);
    assert.equal(isRequiredByRunning(all, base, ['postgres']), false);
    assert.equal(requirerOf(all, kafka, ['kafka', 'bank'])?.title, 'ЗапускБанк');
  });

  it('не назначенный студенту стенд, который нужен банку, в меню помечен причиной, а не «не назначен»', () => {
    const all = session([base, kafka, bank]);
    const rows = buildRows(all, [
      { name: 'stands-kit-postgres', profile: 'postgres', running: true },
      { name: 'stands-kit-bank-core', profile: 'bank', running: true },
    ], null);
    assert.equal(rows.find((row) => row.key === 'kit-postgres')?.note, 'нужен для «ЗапускБанк»');
    assert.equal(rows.find((row) => row.key === 'kit-postgres')?.state, 'running');
    assert.equal(rows.find((row) => row.key === 'kit-kafka')?.state, 'unavailable');
    assert.equal(rows.find((row) => row.key === 'kit-kafka')?.note, 'не назначен');
  });
});
