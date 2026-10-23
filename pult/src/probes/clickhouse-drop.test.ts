import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tablesToDrop, type ClickhouseTable } from './clickhouse-drop';

const kafka = (name: string, topic: string): ClickhouseTable => ({
  name,
  engine: 'Kafka',
  engineFull: `Kafka SETTINGS kafka_broker_list = 'redpanda:9092', kafka_topic_list = '${topic}', kafka_group_name = 'g'`,
  createQuery: '',
});
const mergeTree = (name: string): ClickhouseTable => ({ name, engine: 'MergeTree', engineFull: 'MergeTree ORDER BY x', createQuery: '' });
const view = (name: string, target: string, source: string): ClickhouseTable => ({
  name,
  engine: 'MaterializedView',
  engineFull: '',
  createQuery: `CREATE MATERIALIZED VIEW student.${name} TO student.${target} AS SELECT * FROM student.${source}`,
});

const TABLES = [
  kafka('created_queue', 'bank.payments.created'),
  kafka('decisions_queue', 'bank.antifraud.decisions'),
  mergeTree('transfers'),
  mergeTree('transfer_statuses'),
  mergeTree('antifraud_decisions'),
  mergeTree('notes'),
  view('created_mv', 'transfers', 'created_queue'),
  view('decisions_mv', 'antifraud_decisions', 'decisions_queue'),
];

describe('tablesToDrop', () => {
  it('названные таблицы, очереди Kafka по топику и представления между ними; представления идут первыми', () => {
    const doomed = tablesToDrop(TABLES, ['transfers', 'transfer_statuses'], ['bank.payments.created']);
    assert.deepEqual(new Set(doomed), new Set(['transfers', 'transfer_statuses', 'created_queue', 'created_mv']));
    assert.equal(doomed[0], 'created_mv');
  });

  it('чужие таблицы и очереди других топиков остаются', () => {
    const doomed = tablesToDrop(TABLES, ['antifraud_decisions'], ['bank.antifraud.decisions']);
    assert.deepEqual(new Set(doomed), new Set(['antifraud_decisions', 'decisions_queue', 'decisions_mv']));
  });

  it('представление находится по имени таблицы целиком, а не по части имени', () => {
    const partial = [mergeTree('transfers'), mergeTree('transfers_archive'), view('archive_mv', 'transfers_archive', 'other')];
    assert.deepEqual(tablesToDrop(partial, ['transfers'], []), ['transfers']);
  });

  it('ничего не названо — ничего не удаляется', () => {
    assert.deepEqual(tablesToDrop(TABLES, [], []), []);
  });
});
