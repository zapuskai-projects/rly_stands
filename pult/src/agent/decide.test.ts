import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Session, SessionResult } from '../platform/types';
import { decideStops, REASON_DISABLED, REASON_NOT_ASSIGNED, REASON_PROJECT_CLOSED, REASON_TOKEN } from './decide';

function session(modules: Session['modules'], graceHours = 24): Session {
  return {
    user: { name: 'Юлия' },
    token: { expiresAt: '2026-11-03T12:00:00Z' },
    kit: { latestVersion: '0.1.0', minVersion: '0.1.0', offlineGraceHours: graceHours },
    modules,
    tasks: [],
  };
}

const rabbit = {
  key: 'kit-rabbitmq',
  title: 'RabbitMQ',
  profile: 'rabbitmq',
  minMemoryMb: 400,
  uis: [],
  allowed: true,
  reason: null,
};
const kafka = { ...rabbit, key: 'kit-kafka', title: 'Kafka', profile: 'kafka', minMemoryMb: 1200 };
const NOW = Date.parse('2026-10-20T12:00:00Z');
const ok = (modules: Session['modules']): SessionResult => ({ ok: true, session: session(modules) });

describe('decideStops', () => {
  it('ничего не трогает, когда всё разрешено', () => {
    const stops = decideStops({
      result: ok([rabbit, kafka]),
      runningProfiles: ['rabbitmq', 'kafka'],
      lastSession: null,
      lastOkAt: NOW,
      now: NOW,
    });
    assert.deepEqual(stops, []);
  });

  it('модуль пропал из ответа — выключен на платформе', () => {
    const stops = decideStops({
      result: ok([rabbit]),
      runningProfiles: ['rabbitmq', 'kafka'],
      lastSession: session([rabbit, kafka]),
      lastOkAt: NOW,
      now: NOW,
    });
    assert.deepEqual(stops, [
      { profile: 'kafka', moduleKey: 'kit-kafka', title: 'Kafka', reason: REASON_DISABLED },
    ]);
  });

  it('модуль перестал быть назначен — причина из ответа', () => {
    const stops = decideStops({
      result: ok([rabbit, { ...kafka, allowed: false, reason: REASON_NOT_ASSIGNED }]),
      runningProfiles: ['kafka'],
      lastSession: null,
      lastOkAt: NOW,
      now: NOW,
    });
    assert.equal(stops[0]?.reason, REASON_NOT_ASSIGNED);
    assert.equal(stops[0]?.title, 'Kafka');
  });

  it('токен отозван — останавливается всё, что запущено', () => {
    const stops = decideStops({
      result: { ok: false, kind: 'rejected', message: 'x' },
      runningProfiles: ['rabbitmq', 'kafka'],
      lastSession: session([rabbit, kafka]),
      lastOkAt: NOW,
      now: NOW,
    });
    assert.deepEqual(
      stops.map((stop) => [stop.profile, stop.reason]),
      [
        ['rabbitmq', REASON_TOKEN],
        ['kafka', REASON_TOKEN],
      ],
    );
  });

  it('нет связи меньше допуска — работаем дальше', () => {
    const stops = decideStops({
      result: { ok: false, kind: 'unreachable', message: 'x' },
      runningProfiles: ['rabbitmq'],
      lastSession: session([rabbit]),
      lastOkAt: NOW - 23 * 3600 * 1000,
      now: NOW,
    });
    assert.deepEqual(stops, []);
  });

  it('нет связи дольше допуска — всё останавливается', () => {
    const stops = decideStops({
      result: { ok: false, kind: 'unreachable', message: 'x' },
      runningProfiles: ['rabbitmq', 'kafka'],
      lastSession: session([rabbit, kafka]),
      lastOkAt: NOW - 25 * 3600 * 1000,
      now: NOW,
    });
    assert.equal(stops.length, 2);
    assert.match(stops[0]?.reason ?? '', /нет связи с платформой дольше 24 ч/);
  });

  it('без сохранённой сессии при недоступной платформе ничего не делает', () => {
    const stops = decideStops({
      result: { ok: false, kind: 'unreachable', message: 'x' },
      runningProfiles: ['rabbitmq'],
      lastSession: null,
      lastOkAt: null,
      now: NOW,
    });
    assert.deepEqual(stops, []);
  });

  it('не назначенный стенд, нужный работающему банку, не останавливается; без банка — останавливается', () => {
    const postgres = { ...rabbit, key: 'kit-postgres', title: 'PostgreSQL', profile: 'postgres', allowed: false, reason: null };
    const bank = { ...rabbit, key: 'kit-bank', title: 'ЗапускБанк', profile: 'bank', requires: ['kit-postgres'] };
    const withBank = decideStops({
      result: ok([postgres, bank]),
      runningProfiles: ['postgres', 'bank'],
      lastSession: null,
      lastOkAt: NOW,
      now: NOW,
    });
    assert.deepEqual(withBank, []);
    const withoutBank = decideStops({
      result: ok([postgres, bank]),
      runningProfiles: ['postgres'],
      lastSession: null,
      lastOkAt: NOW,
      now: NOW,
    });
    assert.deepEqual(withoutBank, [{ profile: 'postgres', moduleKey: 'kit-postgres', title: 'PostgreSQL', reason: REASON_NOT_ASSIGNED }]);
  });

  it('зависимость, которую поднимают ради запускаемого банка, не останавливается, пока банк ещё не поднялся', () => {
    const postgres = { ...rabbit, key: 'kit-postgres', title: 'PostgreSQL', profile: 'postgres', allowed: false, reason: null };
    const bank = { ...rabbit, key: 'kit-bank', title: 'ЗапускБанк', profile: 'bank', requires: ['kit-postgres'] };
    const starting = decideStops({
      result: ok([postgres, bank]),
      runningProfiles: ['postgres'],
      startingProfiles: ['bank'],
      lastSession: null,
      lastOkAt: NOW,
      now: NOW,
    });
    assert.deepEqual(starting, []);
    const unrelated = decideStops({
      result: ok([postgres, bank]),
      runningProfiles: ['postgres'],
      startingProfiles: ['rabbitmq'],
      lastSession: null,
      lastOkAt: NOW,
      now: NOW,
    });
    assert.equal(unrelated.length, 1);
  });

  it('модуль проекта пропал — проект закрыт, а не «выключен на платформе»', () => {
    const bank = { ...rabbit, key: 'kit-bank', title: 'ЗапускБанк', profile: 'bank', project: 'zapusk-bank' };
    const stops = decideStops({
      result: ok([rabbit]),
      runningProfiles: ['rabbitmq', 'bank'],
      lastSession: session([rabbit, bank]),
      lastOkAt: NOW,
      now: NOW,
    });
    assert.deepEqual(stops, [
      { profile: 'bank', moduleKey: 'kit-bank', title: 'ЗапускБанк', reason: REASON_PROJECT_CLOSED },
    ]);
  });
});
