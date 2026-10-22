import { randomUUID } from 'node:crypto';
import { asArray, asRecord, failure, http, num, str } from './http';
import { executor, sleep, type ExecutorTable } from './types';

const MODULE = 'RabbitMQ';
const BASE = 'http://rabbitmq:15672/api';
const AUTH = 'guest:guest';
const VHOST = '%2F';
const DEFAULT_WAIT_MS = 1000;
const PEEK_COUNT = 500;

const call = (path: string, options: Parameters<typeof http>[2] = {}) =>
  http(MODULE, `${BASE}${path}`, { basic: AUTH, ...options });

const exchangeId = (name: string) => encodeURIComponent(name === '' ? 'amq.default' : name);

type RouteParams = {
  exchange: string;
  routingKey: string;
  headers?: Record<string, string>;
  payload: string;
  expirationMs?: number;
  watchQueues: string[];
  waitMs?: number;
};

type PublishParams = Omit<RouteParams, 'watchQueues' | 'waitMs'> & { priority?: number };

type OrderMessage = { id: string; priority?: number; payload?: string };

type ReadOrderParams = {
  exchange: string;
  routingKey: string;
  queue: string;
  messages: OrderMessage[];
  waitMs?: number;
};

export function readOrderFacts(sent: Array<{ id: string; marker: string }>, returned: string[]) {
  const idByMarker = new Map(sent.map((item) => [item.marker, item.id]));
  const readOrder = returned.flatMap((marker) => idByMarker.get(marker) ?? []);
  return { readOrder, missing: sent.map((item) => item.id).filter((id) => !readOrder.includes(id)) };
}

async function publishMessage(params: PublishParams, marker: string) {
  const properties: Record<string, unknown> = {
    message_id: marker,
    delivery_mode: 2,
    headers: params.headers ?? {},
  };
  if (params.expirationMs) properties.expiration = String(params.expirationMs);
  if (params.priority !== undefined) properties.priority = params.priority;
  return call(`/exchanges/${VHOST}/${exchangeId(params.exchange)}/publish`, {
    method: 'POST',
    json: {
      properties,
      routing_key: params.routingKey,
      payload: params.payload,
      payload_encoding: 'string',
    },
  });
}

async function peekMarkers(queue: string): Promise<string[] | null> {
  const result = await call(`/queues/${VHOST}/${encodeURIComponent(queue)}/get`, {
    method: 'POST',
    json: { count: PEEK_COUNT, ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 200 },
  });
  if (!result.ok) return null;
  return asArray(result.json).map((message) => str(asRecord(asRecord(message).properties).message_id));
}

async function hasMarker(queue: string, marker: string): Promise<boolean> {
  return ((await peekMarkers(queue)) ?? []).includes(marker);
}

export const RABBITMQ_EXECUTORS: ExecutorTable = {
  'rabbitmq.exchange': executor<{ name: string }>(async ({ name }) => {
    const result = await call(`/exchanges/${VHOST}/${exchangeId(name)}`);
    if (result.status === 404) {
      return { exists: false, name, type: null, durable: false, autoDelete: false, arguments: {} };
    }
    if (!result.ok) throw failure(MODULE, 'чтение обменника', result);
    const body = asRecord(result.json);
    return {
      exists: true,
      name,
      type: str(body.type),
      durable: body.durable === true,
      autoDelete: body.auto_delete === true,
      arguments: asRecord(body.arguments),
    };
  }),

  'rabbitmq.queue': executor<{ name: string }>(async ({ name }) => {
    const result = await call(`/queues/${VHOST}/${encodeURIComponent(name)}`);
    if (result.status === 404) {
      return { exists: false, name, durable: false, autoDelete: false, messages: 0, arguments: {} };
    }
    if (!result.ok) throw failure(MODULE, 'чтение очереди', result);
    const body = asRecord(result.json);
    return {
      exists: true,
      name,
      durable: body.durable === true,
      autoDelete: body.auto_delete === true,
      messages: num(body.messages, num(body.messages_ready) + num(body.messages_unacknowledged)),
      arguments: asRecord(body.arguments),
    };
  }),

  'rabbitmq.bindings': executor<{ source: string }>(async ({ source }) => {
    const result = await call(`/exchanges/${VHOST}/${exchangeId(source)}/bindings/source`);
    if (result.status === 404) return { count: 0, bindings: [] };
    if (!result.ok) throw failure(MODULE, 'чтение привязок', result);
    const bindings = asArray(result.json).map((item) => {
      const row = asRecord(item);
      return {
        destination: str(row.destination),
        destinationType: str(row.destination_type),
        routingKey: str(row.routing_key),
        arguments: asRecord(row.arguments),
      };
    });
    return { count: bindings.length, bindings };
  }),

  'rabbitmq.route': executor<RouteParams>(async (params) => {
    const marker = randomUUID();
    const published = await publishMessage(params, marker);
    const queues: Record<string, number> = Object.fromEntries(params.watchQueues.map((name) => [name, 0]));
    if (published.status === 404) {
      return { published: false, routed: false, deliveredTo: [], notDeliveredTo: params.watchQueues, queues };
    }
    if (!published.ok) throw failure(MODULE, 'публикация сообщения', published);
    await sleep(params.waitMs ?? DEFAULT_WAIT_MS);
    const deliveredTo: string[] = [];
    for (const queue of params.watchQueues) {
      if (await hasMarker(queue, marker)) {
        deliveredTo.push(queue);
        queues[queue] = 1;
      }
    }
    return {
      published: true,
      routed: asRecord(published.json).routed === true,
      deliveredTo,
      notDeliveredTo: params.watchQueues.filter((queue) => !deliveredTo.includes(queue)),
      queues,
    };
  }),

  'rabbitmq.readOrder': executor<ReadOrderParams>(async (params) => {
    const sent: Array<{ id: string; marker: string }> = [];
    let routed = true;
    for (const message of params.messages) {
      const marker = randomUUID();
      const published = await publishMessage(
        {
          exchange: params.exchange,
          routingKey: params.routingKey,
          payload: message.payload ?? JSON.stringify({ id: message.id }),
          priority: message.priority,
        },
        marker,
      );
      if (published.status === 404) {
        return { published: false, routed: false, readOrder: [], missing: params.messages.map((item) => item.id) };
      }
      if (!published.ok) throw failure(MODULE, 'публикация сообщения', published);
      routed = routed && asRecord(published.json).routed === true;
      sent.push({ id: message.id, marker });
    }
    await sleep(params.waitMs ?? DEFAULT_WAIT_MS);
    return { published: true, routed, ...readOrderFacts(sent, (await peekMarkers(params.queue)) ?? []) };
  }),

  'rabbitmq.importDefinitions': executor<{ definitions: Record<string, unknown> }>(async ({ definitions }) => {
    const result = await call('/definitions', { method: 'POST', json: definitions });
    if (!result.ok) throw failure(MODULE, 'загрузка определений', result);
    return { imported: true };
  }),

  'rabbitmq.publish': executor<PublishParams>(async (params) => {
    const result = await publishMessage(params, randomUUID());
    if (!result.ok) throw failure(MODULE, 'публикация сообщения', result);
    return { routed: asRecord(result.json).routed === true };
  }),
};
