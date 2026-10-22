import express from 'express';
import type { Config } from '../config';
import { createDecisionProducer } from '../events/decision-sender';
import { handleCreatedMessage } from '../events/handlers';
import { createKafka, startKafkaConsumer } from '../events/kafka';
import { configureTopics } from '../events/topics';
import { loadBankClock, startClockSync } from '../scenario/bank-time';
import { logger } from '../shared/logger';
import { Readiness } from '../shared/readiness';
import { connectDatabase, onShutdown } from './common';

export async function runAntifraud(config: Config): Promise<void> {
  const topics = configureTopics(config.topicPrefix);
  const pool = await connectDatabase(config);
  const clock = await loadBankClock(pool);
  const clockSync = startClockSync(pool, clock);

  const kafka = createKafka(config.kafkaBrokers, 'bank-antifraud');
  const producer = createDecisionProducer(kafka, topics.antifraudDecisions);
  producer.warmUp();
  const consumer = startKafkaConsumer({
    kafka,
    groupId: 'bank-antifraud',
    topic: topics.paymentsCreated,
    onMessage: (message) => handleCreatedMessage({ pool, clock }, producer.send, message),
  });

  const readiness = new Readiness();
  readiness.add('kafka consumer', consumer.isReady);
  readiness.add('kafka producer', producer.isReady);
  const health = express();
  health.get('/health', (_req, res) => {
    const ready = readiness.isReady();
    res.status(ready ? 200 : 503).json({ status: ready ? 'UP' : 'DOWN' });
  });
  const server = health.listen(config.port, '0.0.0.0', () => logger.info('bank antifraud started', { port: config.port }));
  onShutdown(async () => {
    clockSync.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await consumer.stop();
    await producer.close();
    await pool.end();
  });
}
