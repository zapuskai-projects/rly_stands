import { connect, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { describeError } from '../shared/errors';
import { logger } from '../shared/logger';
import type { BackgroundLoop, EventTransport } from './outbox.publisher';
import type { OutboxRecord } from './outbox.repository';
import { NOTIFICATION_ROUTING_KEY, type TopicNames } from './topics';

const RETRY_DELAY_MS = 2000;

export async function assertNotificationTopology(channel: ConfirmChannel, names: TopicNames): Promise<void> {
  await channel.assertExchange(names.notificationsDlx, 'fanout', { durable: true });
  await channel.assertQueue(names.notificationsDlq, { durable: true });
  await channel.bindQueue(names.notificationsDlq, names.notificationsDlx, '');
  await channel.assertExchange(names.notificationsExchange, 'direct', { durable: true });
  await channel.assertQueue(names.notificationsQueue, {
    durable: true,
    arguments: { 'x-dead-letter-exchange': names.notificationsDlx },
  });
  await channel.bindQueue(names.notificationsQueue, names.notificationsExchange, NOTIFICATION_ROUTING_KEY);
}

interface Session {
  connection: ChannelModel;
  channel: ConfirmChannel;
}

async function openSession(url: string, names: TopicNames): Promise<Session> {
  const connection = await connect(url);
  connection.on('error', () => undefined);
  const channel = await connection.createConfirmChannel();
  channel.on('error', () => undefined);
  await assertNotificationTopology(channel, names);
  return { connection, channel };
}

export class RabbitTransport implements EventTransport {
  private session: Promise<Session> | null = null;

  constructor(
    private readonly url: string,
    private readonly names: TopicNames,
  ) {}

  private open(): Promise<Session> {
    if (!this.session) {
      this.session = openSession(this.url, this.names).catch((error: unknown) => {
        this.session = null;
        throw error;
      });
    }
    return this.session;
  }

  async send(record: OutboxRecord): Promise<void> {
    const { channel, connection } = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        channel.publish(
          record.topic,
          record.key ?? NOTIFICATION_ROUTING_KEY,
          Buffer.from(JSON.stringify(record.payload)),
          { persistent: true, contentType: 'application/json', headers: record.headers },
          (error) => (error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve()),
        );
      });
    } catch (error) {
      this.session = null;
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    const session = await this.session?.catch(() => null);
    await session?.connection.close().catch(() => undefined);
  }
}

export interface RabbitMessageView {
  body: string;
  headers: Record<string, string>;
}

export interface NotificationConsumerOptions {
  url: string;
  names: TopicNames;
  onMessage: (message: RabbitMessageView) => Promise<void>;
}

export interface ReadyConsumer extends BackgroundLoop {
  isReady(): boolean;
}

export function startNotificationConsumer(options: NotificationConsumerOptions): ReadyConsumer {
  let stopped = false;
  let consuming = false;
  let session: Session | null = null;
  const handle = async (channel: ConfirmChannel, message: ConsumeMessage | null): Promise<void> => {
    if (!message) return;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(message.properties.headers ?? {})) headers[name] = String(value);
    try {
      await options.onMessage({ body: message.content.toString(), headers });
      channel.ack(message);
    } catch (error) {
      logger.error('notification rejected to dead letter queue', {
        operationId: headers.operationId,
        requestId: headers.requestId,
        error: describeError(error),
      });
      channel.nack(message, false, false);
    }
  };
  const loop = (async () => {
    while (!stopped) {
      try {
        session = await openSession(options.url, options.names);
        const { channel, connection } = session;
        await channel.prefetch(10);
        await channel.consume(options.names.notificationsQueue, (message) => void handle(channel, message));
        consuming = true;
        logger.info('notification consumer started', { queue: options.names.notificationsQueue });
        await new Promise<void>((resolve) => {
          connection.on('close', () => resolve());
          if (stopped) resolve();
        });
      } catch (error) {
        logger.warn('rabbitmq is not ready', { error: error instanceof Error ? error.message : String(error) });
      }
      consuming = false;
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  })();
  return {
    isReady: () => consuming,
    async stop() {
      stopped = true;
      await session?.connection.close().catch(() => undefined);
      await loop;
    },
  };
}
