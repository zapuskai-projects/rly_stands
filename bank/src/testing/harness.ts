import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { buildApp } from '../api/app';
import { loadContract } from '../api/contract';
import { BankClock } from '../clock/bank-clock';
import { MIGRATIONS_DIR, OPENAPI_PATH } from '../config';
import { runMigrations } from '../db/migrate';
import { searchPathOptions } from '../db/schemas';
import { handleCreatedMessage, handleDecisionMessage, handleNotificationMessage } from '../events/handlers';
import { publishPending, type EventTransport } from '../events/outbox.publisher';
import type { StatusObservation } from '../events/status-observation';
import type { OutboxRecord } from '../events/outbox.repository';
import { configureTopics, getTopics } from '../events/topics';
import { expireOverdueReviews } from '../review/review.service';
import { dispatchPendingSbp, recoverStuckSbp } from '../sbp/dispatcher';
import type { SbpAnswer, SbpGateway, SbpRequest } from '../sbp/gateway';
import { OPERATOR_SEEDS } from '../seed/operators';
import { seedIfEmpty } from '../seed/seed';

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export function pick(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export interface PublishedEvent {
  topic: string;
  key: string | null;
  headers: Record<string, string>;
  payload: unknown;
}

export type SbpScript = SbpAnswer['kind'];

class ScriptedSbp implements SbpGateway {
  constructor(private readonly pool: Pool) {}

  mode: SbpScript = 'ACCEPTED';
  readonly requests: SbpRequest[] = [];

  lookup = async (phone: string, bankCode: string): Promise<string | null> => {
    const result = await this.pool.query<{ display_name: string }>(
      'SELECT display_name FROM sbp_directory WHERE phone = $1 AND bank_code = $2',
      [phone, bankCode],
    );
    return result.rows[0]?.display_name ?? null;
  };

  async send(request: SbpRequest): Promise<SbpAnswer> {
    this.requests.push(request);
    if (this.mode === 'ACCEPTED') return { kind: 'ACCEPTED', reference: 'SBP-TEST' };
    if (this.mode === 'REJECTED') return { kind: 'REJECTED', reason: 'RECIPIENT_BANK_DECLINED' };
    if (this.mode === 'UNAVAILABLE') return { kind: 'UNAVAILABLE', reason: 'нет соединения' };
    return { kind: 'TIMEOUT' };
  }
}

export interface DrainOptions {
  brokerDown?: boolean;
  sbp?: boolean;
  onStatusChanged?: (observation: StatusObservation) => void;
}

export interface Harness {
  pool: Pool;
  clock: BankClock;
  baseUrl: string;
  events: PublishedEvent[];
  sbp: ScriptedSbp;
  setTime(instant: Date): void;
  login(phone: string): Promise<string>;
  operatorLogin(login?: string): Promise<string>;
  api(token: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse>;
  kit(method: string, path: string, body?: unknown, secret?: string | null): Promise<ApiResponse>;
  drain(options?: DrainOptions): Promise<void>;
  expireReviews(): Promise<number>;
  recoverSbp(timeoutMs: number): Promise<number>;
  deps: { pool: Pool; clock: BankClock };
  close(): Promise<void>;
}

export const KIT_TEST_SECRET = 'kit-test-secret';

export interface HarnessOptions {
  kitSecret?: string | null;
  afterReset?: () => Promise<void>;
}

export async function startHarness(databaseUrl: string, startTime: Date, options: HarnessOptions = {}): Promise<Harness> {
  const schema = `bank_test_${randomBytes(6).toString('hex')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 10, options: searchPathOptions({ business: schema, internal: `${schema}_internal` }) });
  const state = { now: startTime.getTime() };
  const clock = new BankClock(() => state.now);
  configureTopics('');
  await runMigrations(pool, MIGRATIONS_DIR);
  await seedIfEmpty(pool, clock);
  const app = buildApp({ pool, clock, contract: loadContract(OPENAPI_PATH), lookupRecipient: (phone, bankCode) => sbp.lookup(phone, bankCode), kitSecret: options.kitSecret ?? null, afterReset: options.afterReset });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const events: PublishedEvent[] = [];
  const sbp = new ScriptedSbp(pool);
  const deps = { pool, clock };
  let brokerDown = false;

  const loopback: EventTransport = {
    async send(record: OutboxRecord) {
      if (brokerDown) throw new Error('брокер недоступен');
      events.push({ topic: record.topic, key: record.key, headers: record.headers, payload: record.payload });
      const topics = getTopics();
      if (record.destination === 'RABBIT') {
        await handleNotificationMessage(deps, JSON.stringify(record.payload), record.headers);
      } else if (record.topic === topics.paymentsCreated) {
        const message = { value: JSON.stringify(record.payload), key: record.key, headers: record.headers };
        await handleCreatedMessage(deps, async (decision, headers) => {
          events.push({ topic: topics.antifraudDecisions, key: decision.clientNumber, headers, payload: decision });
          await handleDecisionMessage(deps, { value: JSON.stringify(decision), key: decision.clientNumber, headers });
        }, message);
      }
    },
  };

  const api: Harness['api'] = async (token, method, path, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? (JSON.parse(text) as unknown) : null };
  };

  const kit: Harness['kit'] = (method, path, body, secret = KIT_TEST_SECRET) =>
    api(null, method, path, body, secret === null ? {} : { 'X-Kit-Secret': secret });

  return {
    pool,
    clock,
    baseUrl,
    events,
    sbp,
    setTime: (instant) => {
      state.now = instant.getTime();
    },
    async login(phone) {
      const challenge = await api(null, 'POST', '/api/v1/auth/login', { phone });
      const sms = await api(null, 'GET', `/api/v1/sandbox/sms?phone=${encodeURIComponent(phone)}&limit=1`);
      const code = /[0-9]{6}/.exec(String(pick(sms.body, 'items.0.text')))?.[0];
      const verified = await api(null, 'POST', '/api/v1/auth/verify', { challengeId: pick(challenge.body, 'challengeId'), code });
      return String(pick(verified.body, 'accessToken'));
    },
    async operatorLogin(login = 'operator') {
      const seed = OPERATOR_SEEDS.find((item) => item.login === login);
      const response = await api(null, 'POST', '/api/v1/office/auth/login', { login, password: seed?.password ?? '' });
      return String(pick(response.body, 'accessToken'));
    },
    api,
    kit,
    async drain(options = {}) {
      brokerDown = options.brokerDown ?? false;
      for (let round = 0; round < 20; round += 1) {
        const published = await publishPending(pool, loopback, { clock, onStatusChanged: options.onStatusChanged });
        const dispatched = options.sbp === false ? 0 : await dispatchPendingSbp(deps, sbp);
        if (published.failed) return;
        if (published.published === 0 && dispatched === 0) return;
      }
      throw new Error('Очередь событий не опустела за 20 проходов');
    },
    expireReviews: () => expireOverdueReviews(deps),
    recoverSbp: (timeoutMs) => recoverStuckSbp(deps, timeoutMs),
    deps,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema}_internal CASCADE`);
      await admin.end();
    },
  };
}
