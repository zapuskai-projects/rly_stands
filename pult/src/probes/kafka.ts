import { randomUUID } from 'node:crypto';
import {
  ConfigResourceTypes,
  Kafka,
  logLevel,
  Partitioners,
  type Admin,
  type IHeaders,
} from 'kafkajs';
import { ProbeError, errorText } from './errors';
import { executor, type ExecutorTable } from './types';

const MODULE = 'Kafka';
const BROKERS = ['redpanda:9092'];
const DEFAULT_MESSAGE_LIMIT = 50;
const DEFAULT_ORDER_FIELD = 'at';
const FIELD_DEPTH = 4;
const READ_TIMEOUT_MS = 8000;

type Message = { key: string; value: string; headers?: Record<string, string> };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function fieldPaths(value: unknown, prefix = '', depth = 0): string[] {
  if (!isPlainRecord(value) || depth > FIELD_DEPTH) return [];
  const paths: string[] = [];
  for (const [name, nested] of Object.entries(value)) {
    const path = `${prefix}${name}`;
    paths.push(path);
    if (Array.isArray(nested)) {
      const first = nested.find(isPlainRecord);
      if (first) paths.push(...fieldPaths(first, `${path}[].`, depth + 1));
    } else {
      paths.push(...fieldPaths(nested, `${path}.`, depth + 1));
    }
  }
  return paths;
}

export function describeMessage<T extends { value: string }>(message: T) {
  let parsed: unknown = message.value;
  try {
    parsed = JSON.parse(message.value);
  } catch {
    parsed = message.value;
  }
  const { value: raw, ...rest } = message;
  return { ...rest, value: parsed, raw, fields: isPlainRecord(parsed) ? [...new Set(fieldPaths(parsed))] : [] };
}

type KeyedMessage = { key: string; partition: number; offset: number; value: unknown };

export function repeatedEventIds(messages: Array<{ value: unknown }>): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    const id = isPlainRecord(message.value) ? message.value.eventId : undefined;
    if (typeof id === 'string') counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([id]) => id).sort();
}

function sortable(value: unknown): number | string | null {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : time;
}

function inOrder(messages: KeyedMessage[], field: string): boolean {
  const values = messages.map((message) =>
    isPlainRecord(message.value) ? sortable(message.value[field]) : null,
  );
  return values.every((value, index) => {
    const previous = values[index - 1];
    if (value === null) return false;
    return index === 0 || (previous !== null && previous !== undefined && typeof previous === typeof value && previous <= value);
  });
}

export function summarizeByKey(messages: KeyedMessage[], field: string) {
  const keys = [...new Set(messages.map((message) => message.key))];
  return keys.map((key) => {
    const own = messages.filter((message) => message.key === key);
    const partitions = [...new Set(own.map((message) => message.partition))].sort((a, b) => a - b);
    const ok = partitions.every((partition) =>
      inOrder(
        own.filter((message) => message.partition === partition).sort((a, b) => a.offset - b.offset),
        field,
      ),
    );
    return { key, count: own.length, partitions, orderedBy: { field, ok } };
  });
}

export function userTopics(names: string[]): string[] {
  return [...new Set(names)].filter((name) => !name.startsWith('_')).sort();
}

function client(): Kafka {
  return new Kafka({
    clientId: 'stands-kit-pult',
    brokers: BROKERS,
    logLevel: logLevel.NOTHING,
    connectionTimeout: 5000,
    requestTimeout: 10_000,
    retry: { retries: 2, initialRetryTime: 300 },
  });
}

async function withAdmin<T>(work: (admin: Admin) => Promise<T>): Promise<T> {
  const admin = client().admin();
  try {
    await admin.connect();
    return await work(admin);
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    throw new ProbeError(`${MODULE} не отвечает: ${errorText(error)}`);
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

async function topicExists(admin: Admin, name: string): Promise<boolean> {
  return (await admin.listTopics()).includes(name);
}

async function produceMessages(topic: string, messages: Message[]) {
  const producer = client().producer({ createPartitioner: Partitioners.DefaultPartitioner });
  const results: Array<{ key: string; partition: number; offset: number }> = [];
  try {
    await producer.connect();
    for (const message of messages) {
      const sent = await producer.send({
        topic,
        acks: -1,
        messages: [{ key: message.key, value: message.value, headers: message.headers as IHeaders }],
      });
      const record = sent[0];
      results.push({
        key: message.key,
        partition: record?.partition ?? -1,
        offset: Number(record?.baseOffset ?? -1),
      });
    }
  } catch (error) {
    throw new ProbeError(`${MODULE}: запись в топик ${topic} не удалась: ${errorText(error)}`);
  } finally {
    await producer.disconnect().catch(() => undefined);
  }
  return results;
}

function describeKeys(results: Array<{ key: string; partition: number; offset: number }>) {
  const keys: Record<string, { partitions: number[]; samePartition: boolean; ordered: boolean }> = {};
  for (const key of new Set(results.map((item) => item.key))) {
    const own = results.filter((item) => item.key === key);
    const partitions = [...new Set(own.map((item) => item.partition))].sort((a, b) => a - b);
    const ordered = partitions.length === 1 && own.every((item, i) => i === 0 || item.offset > own[i - 1]!.offset);
    keys[key] = { partitions, samePartition: partitions.length === 1, ordered };
  }
  return keys;
}

async function readMessages(topic: string, match: string | undefined, limit: number) {
  const consumer = client().consumer({ groupId: `kit-pult-${randomUUID()}`, maxWaitTimeInMs: 500 });
  const collected: Array<{ partition: number; offset: number; key: string; value: string; headers: Record<string, string> }> = [];
  try {
    const ends = await withAdmin(async (admin) => {
      const offsets = await admin.fetchTopicOffsets(topic);
      return new Map(offsets.map((item) => [item.partition, Number(item.high)]));
    });
    const pending = new Set([...ends].filter(([, high]) => high > 0).map(([partition]) => partition));
    if (!pending.size) return collected;
    await consumer.connect();
    await consumer.subscribe({ topic, fromBeginning: true });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, READ_TIMEOUT_MS);
      consumer
        .run({
          eachMessage: async ({ partition, message }) => {
            const offset = Number(message.offset);
            const key = message.key?.toString() ?? '';
            const value = message.value?.toString() ?? '';
            if (!match || key.includes(match) || value.includes(match)) {
              const headers: Record<string, string> = {};
              for (const [name, raw] of Object.entries(message.headers ?? {})) headers[name] = String(raw ?? '');
              collected.push({ partition, offset, key, value, headers });
            }
            if (offset + 1 >= (ends.get(partition) ?? 0)) pending.delete(partition);
            if (!pending.size || collected.length >= limit) {
              clearTimeout(timer);
              resolve();
            }
          },
        })
        .catch(() => resolve());
    });
  } catch (error) {
    throw new ProbeError(`${MODULE} не отвечает: ${errorText(error)}`);
  } finally {
    await consumer.disconnect().catch(() => undefined);
  }
  return collected.slice(0, limit);
}

export const KAFKA_EXECUTORS: ExecutorTable = {
  'kafka.topic': executor<{ name: string }>(({ name }) =>
    withAdmin(async (admin) => {
      if (!(await topicExists(admin, name))) {
        return { exists: false, name, partitions: 0, replicationFactor: 0, configs: {} };
      }
      const meta = await admin.fetchTopicMetadata({ topics: [name] });
      const partitions = meta.topics[0]?.partitions ?? [];
      const described = await admin.describeConfigs({
        includeSynonyms: false,
        resources: [{ type: ConfigResourceTypes.TOPIC, name }],
      });
      const configs: Record<string, string> = {};
      for (const entry of described.resources[0]?.configEntries ?? []) configs[entry.configName] = entry.configValue;
      return {
        exists: true,
        name,
        partitions: partitions.length,
        replicationFactor: partitions[0]?.replicas.length ?? 0,
        configs,
      };
    }),
  ),

  'kafka.topics': executor<Record<string, never>>(() =>
    withAdmin(async (admin) => {
      const names = userTopics(await admin.listTopics());
      const meta = names.length ? await admin.fetchTopicMetadata({ topics: names }) : { topics: [] };
      const partitions = new Map(meta.topics.map((topic) => [topic.name, topic.partitions.length]));
      return {
        count: names.length,
        names,
        topics: names.map((name) => ({ name, partitions: partitions.get(name) ?? 0 })),
      };
    }),
  ),

  'kafka.consumerGroup': executor<{ groupId: string }>(({ groupId }) =>
    withAdmin(async (admin) => {
      const [group] = (await admin.describeGroups([groupId])).groups;
      if (!group || group.state === 'Dead') {
        return { exists: false, state: 'Dead', members: 0, lag: 0, topics: {} };
      }
      const committed = await admin.fetchOffsets({ groupId });
      const topics: Record<string, { lag: number }> = {};
      let lag = 0;
      for (const topic of committed) {
        const ends = new Map((await admin.fetchTopicOffsets(topic.topic)).map((item) => [item.partition, Number(item.high)]));
        const topicLag = topic.partitions.reduce(
          (sum, item) => sum + Math.max(0, (ends.get(item.partition) ?? 0) - Math.max(0, Number(item.offset))),
          0,
        );
        topics[topic.topic] = { lag: topicLag };
        lag += topicLag;
      }
      return { exists: true, state: group.state, members: group.members.length, lag, topics };
    }),
  ),

  'kafka.messages': executor<{ topic: string; match?: string; limit?: number; orderField?: string }>(async (params) => {
    const exists = await withAdmin((admin) => topicExists(admin, params.topic));
    if (!exists) return { count: 0, byKey: [], messages: [], fields: [], repeatedEventIds: [] };
    const messages = (await readMessages(params.topic, params.match, params.limit ?? DEFAULT_MESSAGE_LIMIT)).map(describeMessage);
    return {
      count: messages.length,
      byKey: summarizeByKey(messages, params.orderField ?? DEFAULT_ORDER_FIELD),
      messages,
      fields: [...new Set(messages.flatMap((message) => message.fields))].sort(),
      repeatedEventIds: repeatedEventIds(messages),
    };
  }),

  'kafka.produceAndLocate': executor<{ topic: string; messages: Message[] }>(async ({ topic, messages }) => {
    const exists = await withAdmin((admin) => topicExists(admin, topic));
    if (!exists) return { results: [], keys: {} };
    const results = await produceMessages(topic, messages);
    return { results, keys: describeKeys(results) };
  }),

  'kafka.createTopic': executor<{ name: string; partitions?: number; configs?: Record<string, string> }>((params) =>
    withAdmin(async (admin) => {
      if (await topicExists(admin, params.name)) return { created: false };
      await admin.createTopics({
        waitForLeaders: true,
        topics: [
          {
            topic: params.name,
            numPartitions: params.partitions ?? 1,
            replicationFactor: 1,
            configEntries: Object.entries(params.configs ?? {}).map(([name, value]) => ({ name, value })),
          },
        ],
      });
      return { created: true };
    }),
  ),

  'kafka.produce': executor<{ topic: string; messages: Message[] }>(async ({ topic, messages }) => {
    await produceMessages(topic, messages);
    return { produced: messages.length };
  }),
};
