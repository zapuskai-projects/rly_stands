import type { Kafka } from 'kafkajs';
import { BankError } from '../shared/errors';
import type { TopicNames } from './topics';

export function clearedTopics(topics: TopicNames): string[] {
  return [topics.paymentsCreated, topics.statusChanged, topics.antifraudDecisions, topics.autopaymentsExecuted];
}

export async function clearKafkaTopics(kafka: Kafka, names: readonly string[]): Promise<void> {
  const admin = kafka.admin();
  try {
    await admin.connect();
    const existing = new Set(await admin.listTopics());
    for (const topic of names.filter((name) => existing.has(name))) {
      const partitions = (await admin.fetchTopicOffsets(topic))
        .filter((item) => item.high !== item.low)
        .map((item) => ({ partition: item.partition, offset: item.high }));
      if (partitions.length > 0) await admin.deleteTopicRecords({ topic, partitions });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new BankError(502, 'TOPICS_NOT_CLEARED', `Не удалось очистить топики банка (${reason}): проверьте, что Kafka запущена, и повторите сброс`);
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}
