export const SCENARIO_NAMES = ['error-spike', 'slow-endpoint', 'memory-growth'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export const ROUTES = ['/api/orders', '/api/payments', '/api/profile'] as const;
export type Route = (typeof ROUTES)[number];

export const SLOW_ROUTE: Route = '/api/payments';
export const BASE_ERROR_RATE = 0.005;
export const SPIKE_ERROR_RATE = 0.3;
export const MAX_GROWTH_MB = 192;

export type ActiveScenario = {
  name: ScenarioName;
  label: string;
  startedAt: number;
  durationSec: number;
};

export type ScenarioRequest = { name: ScenarioName; label: string; durationSec: number };

const MIN_DURATION_SEC = 10;
const MAX_DURATION_SEC = 3600;
const LABEL_RE = /^[a-z0-9-]{1,32}$/;

export function parseScenarioRequest(
  body: unknown,
): { ok: true; value: ScenarioRequest } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'нужен JSON-объект' };
  const row = body as Record<string, unknown>;
  const name = SCENARIO_NAMES.find((candidate) => candidate === row.name);
  if (!name) return { ok: false, error: `name — одно из: ${SCENARIO_NAMES.join(', ')}` };
  if (typeof row.label !== 'string' || !LABEL_RE.test(row.label)) {
    return { ok: false, error: 'label — до 32 символов [a-z0-9-]' };
  }
  const durationSec = row.durationSec;
  if (
    typeof durationSec !== 'number' ||
    !Number.isInteger(durationSec) ||
    durationSec < MIN_DURATION_SEC ||
    durationSec > MAX_DURATION_SEC
  ) {
    return { ok: false, error: `durationSec — целое от ${MIN_DURATION_SEC} до ${MAX_DURATION_SEC}` };
  }
  return { ok: true, value: { name, label: row.label, durationSec } };
}

export function isActive(scenario: ActiveScenario | null, now: number): scenario is ActiveScenario {
  return scenario !== null && now < scenario.startedAt + scenario.durationSec * 1000;
}

export function errorRate(scenario: ActiveScenario | null, now: number): number {
  if (!isActive(scenario, now) || scenario.name !== 'error-spike') return BASE_ERROR_RATE;
  const rampMs = Math.min(30_000, scenario.durationSec * 500);
  const progress = Math.min(1, (now - scenario.startedAt) / rampMs);
  return BASE_ERROR_RATE + (SPIKE_ERROR_RATE - BASE_ERROR_RATE) * progress;
}

export function latencySeconds(
  route: Route,
  scenario: ActiveScenario | null,
  now: number,
  random: () => number,
): number {
  const base = 0.03 + random() * 0.09;
  const slow = isActive(scenario, now) && scenario.name === 'slow-endpoint' && route === SLOW_ROUTE;
  if (slow && random() < 0.15) return 2.2 + random() * 1.3;
  return base;
}

export function memoryTargetMb(scenario: ActiveScenario | null, now: number): number {
  if (!isActive(scenario, now) || scenario.name !== 'memory-growth') return 0;
  const progress = Math.min(1, (now - scenario.startedAt) / (scenario.durationSec * 1000));
  return Math.round(MAX_GROWTH_MB * progress);
}
