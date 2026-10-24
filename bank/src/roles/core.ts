import type { Server } from 'node:http';
import { buildApp } from '../api/app';
import { loadContract } from '../api/contract';
import { OPENAPI_PATH, type Config } from '../config';
import { createKafka, KafkaTransport, startKafkaConsumer } from '../events/kafka';
import { handleDecisionMessage, handleNotificationMessage } from '../events/handlers';
import { clearedTopics, clearKafkaTopics } from '../events/clear-topics';
import { startOutboxPublisher } from '../events/outbox.publisher';
import { RabbitTransport, startNotificationConsumer } from '../events/rabbit';
import { reportStatusChange } from '../events/status-report';
import { configureTopics } from '../events/topics';
import { RoutingTransport } from '../events/transport';
import { startAutopayScheduler } from '../autopayments/autopay-scheduler';
import { bankMetrics } from '../metrics/bank-metrics';
import { databaseReleaseSource } from '../release/release-source';
import { expireOverdueReviews } from '../review/review.service';
import { loadBankClock, startClockSync } from '../scenario/bank-time';
import { loadScenarioLabel } from '../scenario/scenario.repository';
import { HttpSbpGateway } from '../sbp/gateway';
import { startSbpDispatcher } from '../sbp/dispatcher';
import { seedIfEmpty } from '../seed/seed';
import { bindLogContext } from '../shared/log-shipper';
import { logger } from '../shared/logger';
import { Readiness } from '../shared/readiness';
import { connectDatabase, onShutdown } from './common';

const REVIEW_SWEEP_INTERVAL_MS = 2000;

export async function runCore(config: Config): Promise<void> {
  const topics = configureTopics(config.topicPrefix);
  const pool = await connectDatabase(config);
  const clock = await loadBankClock(pool);
  const clockSync = startClockSync(pool, clock);
  bindLogContext({ label: () => loadScenarioLabel(pool), clock });
  await seedIfEmpty(pool, clock);

  const kafka = createKafka(config.kafkaBrokers, 'bank-core');
  const kafkaTransport = new KafkaTransport(kafka, [topics.paymentsCreated, topics.statusChanged, topics.antifraudDecisions]);
  kafkaTransport.warmUp();
  const rabbitTransport = new RabbitTransport(config.rabbitmqUrl as string, topics);
  const publisher = startOutboxPublisher(pool, new RoutingTransport(kafkaTransport, rabbitTransport), {
    clock,
    onStatusChanged: reportStatusChange(bankMetrics),
  });
  const deps = { pool, clock };
  const decisions = startKafkaConsumer({
    kafka,
    groupId: 'bank-core-decisions',
    topic: topics.antifraudDecisions,
    onMessage: (message) => handleDecisionMessage(deps, message),
  });
  const notifications = startNotificationConsumer({
    url: config.rabbitmqUrl as string,
    names: topics,
    onMessage: (message) => handleNotificationMessage(deps, message.body, message.headers),
  });
  const readiness = new Readiness();
  readiness.add('kafka producer', () => kafkaTransport.isReady());
  readiness.add('kafka decisions consumer', decisions.isReady);
  readiness.add('rabbitmq notifications consumer', notifications.isReady);
  const gateway = new HttpSbpGateway(config.sbpUrl as string, config.sbpTimeoutMs);
  const dispatcher = startSbpDispatcher(deps, gateway, config.sbpTimeoutMs);
  const autopayments = startAutopayScheduler({ ...deps, lookupRecipient: gateway.lookup }, databaseReleaseSource(pool));
  let sweeping = false;
  const sweeper = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    expireOverdueReviews(deps)
      .catch((error: unknown) => {
        logger.warn('review sweep failed', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        sweeping = false;
      });
  }, REVIEW_SWEEP_INTERVAL_MS);

  const afterReset = async (): Promise<void> => {
    bankMetrics.reset();
    await clearKafkaTopics(kafka, clearedTopics(topics));
  };
  const app = buildApp({
    pool,
    clock,
    contract: loadContract(OPENAPI_PATH),
    lookupRecipient: gateway.lookup,
    kitSecret: config.kitSecret,
    readiness,
    metrics: bankMetrics,
    afterReset,
  });
  const server: Server = app.listen(config.port, '0.0.0.0', () => logger.info('bank core started', { port: config.port }));
  onShutdown(async () => {
    clearInterval(sweeper);
    autopayments.stop();
    clockSync.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([publisher.stop(), decisions.stop(), notifications.stop(), dispatcher.stop()]);
    await Promise.all([kafkaTransport.close(), rabbitTransport.close()]);
    await pool.end();
  });
}
