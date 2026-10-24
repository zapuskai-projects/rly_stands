import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { ProbeError } from './errors';
import { executor, type ExecutorTable } from './types';

type Received = { status: number; signatureOk: boolean; eventId: string; event: string };

type Receiver = { server: Server; secret: string; responses: number[]; received: Received[]; accepted: number };

const receivers = new Map<number, Receiver>();

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RECEIVED = 200;
const FALLBACK_STATUS = 500;

export function signatureOf(secret: string, body: string | Buffer): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function signatureMatches(secret: string, body: string | Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(signatureOf(secret, body));
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function answerFor(responses: unknown, acceptedBefore: number): number {
  if (!Array.isArray(responses) || !responses.length) return FALLBACK_STATUS;
  const status: unknown = responses[Math.min(acceptedBefore, responses.length - 1)];
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : FALLBACK_STATUS;
}

function eventOf(body: Buffer): string {
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && typeof (parsed as { event?: unknown }).event === 'string'
      ? (parsed as { event: string }).event
      : '';
  } catch {
    return '';
  }
}

function listen(port: number, receiver: Receiver): Promise<void> {
  return new Promise((resolve, reject) => {
    receiver.server.once('error', (error: NodeJS.ErrnoException) =>
      reject(new ProbeError(`Приёмник уведомлений не занял порт ${port}: ${error.code ?? error.message}`)),
    );
    receiver.server.listen(port, '0.0.0.0', resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export function summarize(received: Received[]) {
  const accepted = received.filter((item) => item.signatureOk);
  const eventIds = new Set(accepted.map((item) => item.eventId));
  return {
    received: received.length,
    accepted: accepted.length,
    rejectedBySignature: received.length - accepted.length,
    statuses: received.map((item) => item.status),
    sameEventId: eventIds.size === 1 && !eventIds.has(''),
  };
}

function handle(receiver: Receiver, request: IncomingMessage, response: ServerResponse): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    let status = 413;
    let signatureOk = false;
    let event = '';
    if (!tooLarge) {
      const body = Buffer.concat(chunks);
      signatureOk = signatureMatches(receiver.secret, body, request.headers['x-signature'] as string | undefined);
      status = signatureOk ? answerFor(receiver.responses, receiver.accepted) : 401;
      if (signatureOk) receiver.accepted += 1;
      event = eventOf(body);
    }
    if (receiver.received.length < MAX_RECEIVED) {
      receiver.received.push({ status, signatureOk, eventId: String(request.headers['x-event-id'] ?? ''), event });
    }
    response.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end('{}');
  });
}

export const WEBHOOK_RECEIVER_EXECUTORS: ExecutorTable = {
  'webhook.receiverStart': executor<{ port: number; secret: string; responses: number[] }>(async ({ port, secret, responses }) => {
    const previous = receivers.get(port);
    if (previous) {
      receivers.delete(port);
      await closeServer(previous.server);
    }
    const receiver: Receiver = { secret, responses, received: [], accepted: 0, server: createServer() };
    receiver.server.on('request', (request, response) => handle(receiver, request, response));
    await listen(port, receiver);
    receivers.set(port, receiver);
    return { listening: port, host: hostname() };
  }),

  'webhook.receiverStop': executor<{ port: number }>(async ({ port }) => {
    const receiver = receivers.get(port);
    if (!receiver) throw new ProbeError(`Приёмник на порту ${port} не запущен`);
    receivers.delete(port);
    await closeServer(receiver.server);
    return summarize(receiver.received);
  }),
};
