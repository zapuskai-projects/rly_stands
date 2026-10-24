import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import { logger } from '../shared/logger';
import type { BackgroundLoop, EventTransport } from './outbox.publisher';
import type { OutboxRecord } from './outbox.repository';
import { trackGroupMembership } from './consumer-ready';
import { TOPIC_PARTITIONS } from './topics';

const RETRY_DELAY_MS = 2000;

export function createKafka(brokers: string[], clientId: string): Kafka {
  return new Kafka({ clientId, brokers, logLevel: logLevel.NOTHING, retry: { initialRetryTime: 300, retries: 5 } });
}

export async function ensureTopics(kafka: Kafka, topics: string[]): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({ topics: topics.map((topic) => ({ topic, numPartitions: TOPIC_PARTITIONS, replicationFactor: 1 })) });
  } finally {
    await admin.disconnect();
  }
}

export class KafkaTransport implements EventTransport {
  private producer: Producer | null = null;
  private ready: Promise<Producer> | null = null;
  private readonly ensured: Set<string>;

  constructor(
    private readonly kafka: Kafka,
    private readonly topics: string[],
  ) {
    this.ensured = new Set(topics);
  }

  private connect(): Promise<Producer> {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureTopics(this.kafka, this.topics);
        const producer = this.kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
        await producer.connect();
        this.producer = producer;
        return producer;
      })().catch((error: unknown) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  isReady(): boolean {
    return this.producer !== null;
  }

  warmUp(): void {
    this.connect().catch((error: unknown) => {
      logger.warn('kafka is not ready', { error: error instanceof Error ? error.message : String(error) });
    });
  }

  async send(record: OutboxRecord): Promise<void> {
    const producer = await this.connect();
    try {
      if (!this.ensured.has(record.topic)) {
        await ensureTopics(this.kafka, [record.topic]);
        this.ensured.add(record.topic);
      }
      await producer.send({
        topic: record.topic,
        acks: -1,
        messages: [{ key: record.key, value: JSON.stringify(record.payload), headers: record.headers }],
      });
    } catch (error) {
      this.ready = null;
      this.producer = null;
      await producer.disconnect().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.producer?.disconnect().catch(() => undefined);
  }
}

export interface KafkaMessageView {
  value: string;
  key: string | null;
  headers: Record<string, string>;
}

export interface ConsumerOptions {
  kafka: Kafka;
  groupId: string;
  topic: string;
  onMessage: (message: KafkaMessageView) => Promise<void>;
}

export interface ReadyLoop extends BackgroundLoop {
  isReady(): boolean;
}

export function startKafkaConsumer(options: ConsumerOptions): ReadyLoop {
  let stopped = false;
  let consumer: Consumer | null = null;
  let inGroup: () => boolean = () => false;
  const starting = (async () => {
    while (!stopped) {
      try {
        await ensureTopics(options.kafka, [options.topic]);
        consumer = options.kafka.consumer({ groupId: options.groupId, retry: { retries: 8 } });
        inGroup = trackGroupMembership(consumer, options.topic);
        await consumer.connect();
        await consumer.subscribe({ topic: options.topic, fromBeginning: true });
        await consumer.run({
          eachMessage: async ({ message }) => {
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(message.headers ?? {})) headers[name] = String(value);
            await options.onMessage({ value: message.value?.toString() ?? '', key: message.key?.toString() ?? null, headers });
          },
        });
        logger.info('kafka consumer started', { topic: options.topic, groupId: options.groupId });
        return;
      } catch (error) {
        logger.warn('kafka consumer is not ready', { topic: options.topic, error: error instanceof Error ? error.message : String(error) });
        inGroup = () => false;
        await consumer?.disconnect().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  })();
  return {
    isReady: () => inGroup(),
    async stop() {
      stopped = true;
      await starting;
      await consumer?.disconnect().catch(() => undefined);
    },
  };
}

export class SkippableMessageError extends Error {}

export function parseJsonMessage(message: KafkaMessageView): unknown {
  try {
    return JSON.parse(message.value) as unknown;
  } catch {
    throw new SkippableMessageError('Сообщение не является JSON');
  }
}
