import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KAFKA_EXECUTORS } from './kafka';
import { committedOf, deletableGroups, isProtectedGroup, readersFacts, studentGroupIds, type GroupRow } from './kafka-groups';

const row = (groupId: string, committedTotal: number, members = 0, otherTopicsCommitted = 0): GroupRow => ({
  groupId,
  state: members ? 'Stable' : 'Empty',
  members,
  partitionsCommitted: committedTotal ? 1 : 0,
  committedTotal,
  otherTopicsCommitted,
});

describe('kafka: группы потребителей студента', () => {
  it('группы банка и служебные группы пульта не считаются студенческими', () => {
    const ids = ['bank-core-decisions', 'bank-antifraud', 'kit-pult-1a2b', 'autotests', 'autotests', 'my-reader'];
    assert.deepEqual(studentGroupIds(ids), ['autotests', 'my-reader']);
    assert.deepEqual(studentGroupIds(ids, ['my-reader']), ['autotests']);
  });

  it('смещение -1 — не сохранено, сохранённые суммируются', () => {
    assert.deepEqual(committedOf([{ partition: 0, offset: '-1' }, { partition: 1, offset: '-1' }]), { partitionsCommitted: 0, committedTotal: 0 });
    assert.deepEqual(committedOf([{ partition: 0, offset: '3' }, { partition: 1, offset: '-1' }, { partition: 2, offset: '2' }]), {
      partitionsCommitted: 2,
      committedTotal: 5,
    });
  });

  it('читателями топика считаются только группы с сохранёнными смещениями', () => {
    const facts = readersFacts('bank.payments.created', [row('autotests', 4), row('idle', 0), row('another', 1)]);
    assert.equal(facts.count, 2);
    assert.deepEqual(facts.groupIds, ['another', 'autotests']);
  });

  it('удаляются только пустые группы, с участниками остаются', () => {
    assert.deepEqual(deletableGroups([row('a', 1), row('b', 1, 2)]), { deletable: ['a'], skipped: ['b'] });
  });

  it('группа со смещениями ещё и по другим топикам не удаляется', () => {
    assert.deepEqual(deletableGroups([row('mine', 1), row('shared', 1, 0, 2)]), { deletable: ['mine'], skipped: ['shared'] });
  });

  it('группы банка и kit-pult-* никогда не удаляются и не читаются студентом', () => {
    assert.deepEqual(deletableGroups([row('bank-core-decisions', 1), row('bank-antifraud', 1), row('kit-pult-x', 1)]).deletable, []);
    assert.equal(isProtectedGroup('bank-antifraud'), true);
    assert.equal(isProtectedGroup('kit-pult-x'), true);
    assert.equal(isProtectedGroup('autotests'), false);
  });

  it('kafka.readAsGroup отказывает для групп банка и kit-pult-* до обращения к брокеру', async () => {
    for (const groupId of ['bank-core-decisions', 'bank-antifraud', 'kit-pult-abc']) {
      await assert.rejects(KAFKA_EXECUTORS['kafka.readAsGroup']!({ topic: 'bank.payments.created', groupId }, { workDir: '/tmp', label: 'x', dataDir: '/tmp' }), /служебная/);
    }
  });
});
