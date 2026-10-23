import assert from 'node:assert/strict';
import { before, it } from 'node:test';
import { READINESS } from '../../modules/readiness';
import { liveSuite } from './support';

type Facts = Record<string, any>;

const TOPIC = 'live.drop.topic';
const QUEUE = `CREATE TABLE live_drop_queue (operationNumber String, amount UInt64)
  ENGINE = Kafka SETTINGS kafka_broker_list = 'redpanda:9092', kafka_topic_list = '${TOPIC}', kafka_group_name = 'live-drop', kafka_format = 'JSONEachRow'`;

liveSuite('data', READINESS.clickhouse ?? [], 'ClickHouse: очистка студенческих таблиц', ({ probe }) => {
  const exists = async (name: string) => (await probe<Facts>('clickhouse.table', { name })).exists;

  before(async () => {
    await probe('clickhouse.sql', {
      sql: `
        DROP TABLE IF EXISTS live_drop_view;
        DROP TABLE IF EXISTS live_drop_queue;
        DROP TABLE IF EXISTS live_drop_named;
        DROP TABLE IF EXISTS live_drop_target;
        DROP TABLE IF EXISTS live_drop_keep_view;
        DROP TABLE IF EXISTS live_drop_keep;
        CREATE TABLE live_drop_target (operationNumber String, amount UInt64) ENGINE = MergeTree ORDER BY operationNumber;
        CREATE TABLE live_drop_named (id UInt32) ENGINE = MergeTree ORDER BY id;
        CREATE TABLE live_drop_keep (id UInt32) ENGINE = MergeTree ORDER BY id;
        ${QUEUE};
        CREATE MATERIALIZED VIEW live_drop_view TO live_drop_target AS SELECT operationNumber, amount FROM live_drop_queue;
        CREATE MATERIALIZED VIEW live_drop_keep_view TO live_drop_keep AS SELECT toUInt32(1) AS id FROM live_drop_named;
      `,
    });
  });

  it('удаляются названная таблица, очередь Kafka по топику и представления на них, чужое остаётся', async () => {
    const result = await probe<Facts>('clickhouse.dropTables', { tables: ['live_drop_named'], kafkaTopics: [TOPIC] });
    assert.deepEqual([...result.dropped].sort(), ['live_drop_keep_view', 'live_drop_named', 'live_drop_queue', 'live_drop_view']);
    const views = new Set(['live_drop_keep_view', 'live_drop_view']);
    const lastView = result.dropped.findLastIndex((name: string) => views.has(name));
    const firstTable = result.dropped.findIndex((name: string) => !views.has(name));
    assert.ok(lastView < firstTable, 'представления удаляются раньше таблиц');
    for (const gone of ['live_drop_view', 'live_drop_queue', 'live_drop_named', 'live_drop_keep_view']) {
      assert.equal(await exists(gone), false, gone);
    }
    assert.equal(await exists('live_drop_target'), true);
    assert.equal(await exists('live_drop_keep'), true);
  });

  it('повторная очистка ничего не находит и не падает, пустые списки ничего не трогают', async () => {
    assert.deepEqual(await probe('clickhouse.dropTables', { tables: ['live_drop_named'], kafkaTopics: [TOPIC] }), { dropped: [] });
    assert.deepEqual(await probe('clickhouse.dropTables', {}), { dropped: [] });
    assert.equal(await exists('live_drop_keep'), true);
  });

  it('уборка', async () => {
    await probe('clickhouse.dropTables', { tables: ['live_drop_target', 'live_drop_keep'] });
    assert.equal(await exists('live_drop_target'), false);
    assert.equal(await exists('live_drop_keep'), false);
  });
});

liveSuite('data', (READINESS.elasticsearch ?? []).slice(0, 1), 'Elasticsearch: очистка индексов журнала', ({ probe }) => {
  const exists = async (name: string) => (await probe<Facts>('elasticsearch.index', { name })).exists;

  before(async () => {
    for (const name of ['live-drop-a', 'live-drop-b', 'live-drop-other']) {
      await fetch(`http://elasticsearch:9200/${name}`, { method: 'DELETE' });
      await probe('elasticsearch.createIndex', { name, settings: { number_of_shards: 1, number_of_replicas: 0 } });
    }
  });

  it('шаблон с * в конце удаляет совпавшие индексы и не трогает остальные', async () => {
    const result = await probe<Facts>('elasticsearch.deleteIndices', { pattern: 'live-drop-*' });
    assert.deepEqual([...result.deleted].sort(), ['live-drop-a', 'live-drop-b', 'live-drop-other']);
    assert.equal(await exists('live-drop-a'), false);
    assert.equal(await exists('live-drop-b'), false);
  });

  it('точное имя удаляет один индекс, а несуществующий — это пустой результат, не сбой', async () => {
    await probe('elasticsearch.createIndex', { name: 'live-drop-a', settings: { number_of_shards: 1, number_of_replicas: 0 } });
    await probe('elasticsearch.createIndex', { name: 'live-drop-b', settings: { number_of_shards: 1, number_of_replicas: 0 } });
    assert.deepEqual(await probe('elasticsearch.deleteIndices', { pattern: 'live-drop-a' }), { deleted: ['live-drop-a'] });
    assert.equal(await exists('live-drop-b'), true);
    assert.deepEqual(await probe('elasticsearch.deleteIndices', { pattern: 'live-drop-absent-*' }), { deleted: [] });
    assert.deepEqual(await probe('elasticsearch.deleteIndices', { pattern: 'live-drop-absent' }), { deleted: [] });
  });

  it('шаблон, который задел бы всё подряд или стоит в середине, не принимается и ничего не удаляет', async () => {
    for (const pattern of ['*', 'live-*-b', '_all', '-live-drop-b']) {
      await assert.rejects(probe('elasticsearch.deleteIndices', { pattern }), /не принят/, pattern);
    }
    assert.equal(await exists('live-drop-b'), true);
  });

  it('уборка', async () => {
    await probe('elasticsearch.deleteIndices', { pattern: 'live-drop-*' });
    assert.equal(await exists('live-drop-b'), false);
  });
});
