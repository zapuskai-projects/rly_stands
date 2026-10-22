import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import {
  MAX_GROWTH_MB,
  ROUTES,
  errorRate,
  isActive,
  latencySeconds,
  memoryTargetMb,
  parseScenarioRequest,
  type ActiveScenario,
  type Route,
} from './model';

const PORT = Number(process.env.PORT ?? 8200);
const TRAFFIC_INTERVAL_MS = 100;
const MB = 1024 * 1024;

const registry = new Registry();
collectDefaultMetrics({ register: registry });
const requests = new Counter({
  name: 'http_requests_total',
  help: 'Запросы по маршруту и коду ответа',
  labelNames: ['method', 'route', 'code'],
  registers: [registry],
});
const duration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Задержка ответа по маршруту',
  labelNames: ['route'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});
const scenarioGauge = new Gauge({
  name: 'demo_scenario_active',
  help: 'Активный сценарий учебного приложения',
  labelNames: ['name', 'label'],
  registers: [registry],
});

let scenario: ActiveScenario | null = null;
const ballast: Buffer[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function simulate(route: Route): Promise<number> {
  const now = Date.now();
  const seconds = latencySeconds(route, scenario, now, Math.random);
  await sleep(seconds * 1000);
  const code = Math.random() < errorRate(scenario, Date.now()) ? 500 : 200;
  requests.inc({ method: 'GET', route, code: String(code) });
  duration.observe({ route }, seconds);
  return code;
}

function clearScenario(): void {
  scenarioGauge.reset();
  scenario = null;
  ballast.length = 0;
}

function syncBallast(): void {
  const targetMb = memoryTargetMb(scenario, Date.now());
  while (ballast.length < Math.min(targetMb, MAX_GROWTH_MB)) ballast.push(Buffer.alloc(MB, 1));
  if (scenario && !isActive(scenario, Date.now())) clearScenario();
}

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') return send(response, 200, { status: 'ok' });
  if (url.pathname === '/metrics') {
    response.writeHead(200, { 'Content-Type': registry.contentType });
    response.end(await registry.metrics());
    return;
  }
  if (url.pathname === '/scenario') {
    if (request.method === 'GET') return send(response, 200, { active: scenario });
    if (request.method === 'DELETE') {
      clearScenario();
      return send(response, 200, { active: null });
    }
    if (request.method === 'POST') {
      const parsed = parseScenarioRequest(await readBody(request));
      if (!parsed.ok) return send(response, 400, { error: parsed.error });
      clearScenario();
      scenario = { ...parsed.value, startedAt: Date.now() };
      scenarioGauge.set({ name: scenario.name, label: scenario.label }, 1);
      return send(response, 200, { active: scenario });
    }
  }
  const route = ROUTES.find((candidate) => candidate === url.pathname);
  if (route) {
    const code = await simulate(route);
    return send(response, code, code === 200 ? { ok: true } : { error: 'internal' });
  }
  return send(response, 404, { error: 'not found' });
}

export function runDemoApp(): void {
  setInterval(() => {
    const route = ROUTES[Math.floor(Math.random() * ROUTES.length)];
    if (route) void simulate(route);
    syncBallast();
  }, TRAFFIC_INTERVAL_MS);
  createServer((request, response) => {
    handle(request, response).catch(() => send(response, 500, { error: 'internal' }));
  }).listen(PORT);
}
