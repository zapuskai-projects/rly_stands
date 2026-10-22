import { existsSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

export type ReadyCheck = {
  label: string;
  url?: string;
  tcp?: { host: string; port: number };
  basicAuth?: string;
  timeoutSec: number;
  needsFile?: string;
};

export const READINESS: Record<string, ReadyCheck[]> = {
  rabbitmq: [
    {
      label: 'RabbitMQ',
      url: 'http://rabbitmq:15672/api/overview',
      basicAuth: 'guest:guest',
      timeoutSec: 120,
    },
  ],
  kafka: [
    { label: 'Брокер Kafka', tcp: { host: 'redpanda', port: 9092 }, timeoutSec: 120 },
    { label: 'AKHQ', url: 'http://akhq:8080/', timeoutSec: 120 },
  ],
  camunda: [{ label: 'Operaton', url: 'http://operaton:8080/engine-rest/version', timeoutSec: 240 }],
  elasticsearch: [
    { label: 'Elasticsearch', url: 'http://elasticsearch:9200/_cluster/health', timeoutSec: 240 },
    { label: 'Kibana', url: 'http://kibana:5601/api/status', timeoutSec: 300 },
  ],
  postgres: [{ label: 'PostgreSQL', tcp: { host: 'postgres', port: 5432 }, timeoutSec: 90 }],
  contracts: [
    { label: 'PlantUML-сервер', url: 'http://plantuml:8080/', timeoutSec: 120 },
    { label: 'Prism', url: 'http://prism:4010/', timeoutSec: 120, needsFile: 'work/openapi.yaml' },
  ],
  clickhouse: [{ label: 'ClickHouse', url: 'http://clickhouse:8123/ping', timeoutSec: 120 }],
  monitoring: [
    { label: 'Prometheus', url: 'http://prometheus:9090/-/ready', timeoutSec: 120 },
    { label: 'Grafana', url: 'http://grafana:3000/api/health', timeoutSec: 180 },
    { label: 'Учебное приложение', url: 'http://demo-app:8200/health', timeoutSec: 120 },
  ],
  bank: [
    { label: 'ЗапускБанк: ядро', url: 'http://kit-bank-core:18400/health', timeoutSec: 120 },
    { label: 'ЗапускБанк: антифрод', url: 'http://kit-bank-antifraud:18401/health', timeoutSec: 120 },
    { label: 'ЗапускБанк: СБП', url: 'http://kit-bank-sbp:18402/health', timeoutSec: 120 },
  ],
  linux: [
    { label: 'SSH-сервер', tcp: { host: 'linux-server', port: 22 }, timeoutSec: 90 },
    { label: 'Учебное приложение', url: 'http://linux-server/health', timeoutSec: 90 },
  ],
};

const PROBE_TIMEOUT_MS = 3000;
const POLL_MS = 2000;

function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function probeHttp(url: string, basicAuth?: string): Promise<boolean> {
  try {
    const headers: Record<string, string> = {};
    if (basicAuth) headers.Authorization = `Basic ${Buffer.from(basicAuth).toString('base64')}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export function probe(check: ReadyCheck): Promise<boolean> {
  if (check.tcp) return probeTcp(check.tcp.host, check.tcp.port);
  return check.url ? probeHttp(check.url, check.basicAuth) : Promise.resolve(false);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type ReadyReport = { label: string; ok: boolean; seconds: number; skipped?: string };

export async function waitReady(
  checks: ReadyCheck[],
  kitDir: string,
  onStep: (report: ReadyReport) => void,
  onWaiting: (label: string, seconds: number) => void = () => undefined,
): Promise<ReadyReport[]> {
  const reports: ReadyReport[] = [];
  for (const check of checks) {
    if (check.needsFile && !existsSync(join(kitDir, check.needsFile))) {
      const skipped = { label: check.label, ok: true, seconds: 0, skipped: check.needsFile };
      reports.push(skipped);
      onStep(skipped);
      continue;
    }
    const started = Date.now();
    let ok = await probe(check);
    while (!ok && (Date.now() - started) / 1000 < check.timeoutSec) {
      onWaiting(check.label, Math.round((Date.now() - started) / 1000));
      await sleep(POLL_MS);
      ok = await probe(check);
    }
    const report = { label: check.label, ok, seconds: Math.round((Date.now() - started) / 1000) };
    reports.push(report);
    onStep(report);
  }
  return reports;
}
