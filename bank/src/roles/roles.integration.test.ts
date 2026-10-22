import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { Pool } from 'pg';
import { after, before, describe, it } from 'node:test';
import { createKafka } from '../events/kafka';
import { ROOT_DIR } from '../config';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
const KAFKA = process.env.TEST_KAFKA_BROKERS;
const RABBIT = process.env.TEST_RABBITMQ_URL;
const READY = Boolean(DATABASE_URL && KAFKA && RABBIT);
const SECRET = 'roles-test-secret';
const START_TIMEOUT_MS = 90_000;
const ANTIFRAUD_GROUP = 'bank-antifraud';
const CORE_GROUP = 'bank-core-decisions';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function health(port: number): Promise<number> {
  try {
    return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).status;
  } catch {
    return 0;
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('роли банка как отдельные процессы', { skip: READY ? false : 'нужны TEST_DATABASE_URL, TEST_KAFKA_BROKERS и TEST_RABBITMQ_URL' }, () => {
  const suffix = randomBytes(4).toString('hex');
  const databaseName = `zbroles_${suffix}`;
  const prefix = `r${suffix}.`;
  const children: ChildProcess[] = [];
  const kafka = createKafka((KAFKA as string).split(','), `roles-test-${suffix}`);
  let admin: Pool;
  let corePort = 0;
  let antifraudPort = 0;
  const coreUp: number[] = [];
  const antifraudUp: number[] = [];

  const databaseUrl = () => {
    const url = new URL(DATABASE_URL as string);
    url.pathname = `/${databaseName}`;
    return url.toString();
  };

  function start(role: 'core' | 'antifraud', port: number): ChildProcess {
    const child = spawn(path.join(ROOT_DIR, 'node_modules', '.bin', 'tsx'), ['src/main.ts'], {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        BANK_ROLE: role,
        PORT: String(port),
        BANK_DATABASE_URL: databaseUrl(),
        BANK_KAFKA_BROKERS: KAFKA,
        BANK_RABBITMQ_URL: RABBIT,
        SBP_URL: 'http://127.0.0.1:9',
        KIT_SECRET: SECRET,
        TOPIC_PREFIX: prefix,
      },
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  }

  async function groupMembers(groupId: string): Promise<{ state: string; members: number; topics: string[] }> {
    const client = kafka.admin();
    await client.connect();
    try {
      const [description] = (await client.describeGroups([groupId])).groups;
      const topics = new Set<string>();
      for (const member of description?.members ?? []) {
        const assignment = Buffer.from(member.memberAssignment).toString('latin1');
        for (const topic of [`${prefix}bank.payments.created`, `${prefix}bank.antifraud.decisions`]) if (assignment.includes(topic)) topics.add(topic);
      }
      return { state: description?.state ?? '', members: description?.members.length ?? 0, topics: [...topics] };
    } finally {
      await client.disconnect();
    }
  }

  async function untilHealthy(port: number, seen: number[]): Promise<void> {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await health(port);
      seen.push(status);
      if (status === 200) return;
      await pause(100);
    }
    throw new Error(`/health на порту ${port} не стал 200 за ${START_TIMEOUT_MS} мс: ${seen.slice(-5).join(',')}`);
  }

  before(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 1 });
    [corePort, antifraudPort] = [await freePort(), await freePort()];
  });

  after(async () => {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map((child) => (child.exitCode === null ? new Promise((resolve) => child.once('exit', resolve)) : null)));
    const client = kafka.admin();
    await client.connect();
    await client.deleteTopics({ topics: [`${prefix}bank.payments.created`, `${prefix}bank.payments.status-changed`, `${prefix}bank.antifraud.decisions`] }).catch(() => undefined);
    await client.deleteGroups([ANTIFRAUD_GROUP, CORE_GROUP]).catch(() => undefined);
    await client.disconnect();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  });

  it('антифрод отвечает 200 только когда потребитель уже в группе и получил разделы топика', async () => {
    start('antifraud', antifraudPort);
    await untilHealthy(antifraudPort, antifraudUp);
    const group = await groupMembers(ANTIFRAUD_GROUP);
    assert.equal(group.state, 'Stable');
    assert.equal(group.members, 1);
    assert.deepEqual(group.topics, [`${prefix}bank.payments.created`]);
    assert.ok(!antifraudUp.slice(0, -1).includes(200));
  });

  it('ядро отвечает 200 только когда потребитель решений уже в группе; до этого — не 200', async () => {
    start('core', corePort);
    await untilHealthy(corePort, coreUp);
    const group = await groupMembers(CORE_GROUP);
    assert.equal(group.state, 'Stable');
    assert.equal(group.members, 1);
    assert.deepEqual(group.topics, [`${prefix}bank.antifraud.decisions`]);
    assert.ok(!coreUp.slice(0, -1).includes(200));
  });

  it('первый перевод сразу после готовности обеих ролей проходит быстро, а не висит в CHECKING', async () => {
    const kit = (method: string, route: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${corePort}/_kit${route}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-kit-secret': SECRET },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const created = await kit('POST', '/actions/transfer', { phone: '+79001110001', toPhone: '+79001110002', amountKop: 10_000, idempotencyKey: 'roles-key-0001', label: 'roles:1' });
    assert.equal(created.status, 200);
    const { operationId } = (await created.json()) as { operationId: string };
    const startedAt = Date.now();
    let status = 'CHECKING';
    while (Date.now() - startedAt < 8000 && ['CREATED', 'CHECKING'].includes(status)) {
      status = ((await (await kit('GET', `/facts/operations/${operationId}`)).json()) as { status: string }).status;
      if (['CREATED', 'CHECKING'].includes(status)) await pause(100);
    }
    assert.equal(status, 'COMPLETED');
    assert.ok(Date.now() - startedAt < 8000);
  });
});
