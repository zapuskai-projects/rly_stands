import { errorText } from './errors';
import { EXECUTORS } from './registry';
import type { ProbeContext } from './types';

export type ProbeSpec = { id: string; probe: string; params: Record<string, unknown> };
export type ActionSpec = { action: string; as?: string; params: Record<string, unknown> };

export type Observations = Record<string, unknown>;

export type StepReport = { name: string; ok: boolean; detail: string | null };

export async function collectObservations(
  probes: ProbeSpec[],
  ctx: ProbeContext,
  onStep?: (report: StepReport) => void,
): Promise<Observations> {
  const out: Observations = {};
  for (const probe of probes) {
    const executor = EXECUTORS[probe.probe];
    if (!executor) {
      out[probe.id] = { error: `пульт не знает проверку ${probe.probe}` };
      onStep?.({ name: probe.probe, ok: false, detail: 'неизвестная проверка' });
      continue;
    }
    try {
      out[probe.id] = await executor(probe.params, { ...ctx, observations: out });
      onStep?.({ name: probe.probe, ok: true, detail: null });
    } catch (error) {
      out[probe.id] = { error: errorText(error) };
      onStep?.({ name: probe.probe, ok: false, detail: errorText(error) });
    }
  }
  return out;
}

const RESULT_TOKEN = /\{\{result\.([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z]+)\}\}/g;

export function substituteResults<T>(value: T, results: Record<string, Record<string, unknown>>): T {
  if (typeof value === 'string') {
    return value.replace(RESULT_TOKEN, (_, name: string, field: string) => String(results[name]?.[field] ?? '')) as T;
  }
  if (Array.isArray(value)) return value.map((item) => substituteResults(item, results)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, substituteResults(nested, results)]),
    ) as T;
  }
  return value;
}

export async function runActions(
  actions: ActionSpec[],
  context: ProbeContext,
  onStep?: (report: StepReport) => void,
): Promise<string | null> {
  const results = context.results ?? {};
  const ctx: ProbeContext = { ...context, results };
  for (const action of actions) {
    const executor = EXECUTORS[action.action];
    if (!executor) return `пульт не знает действие ${action.action}`;
    try {
      const outcome = await executor(substituteResults(action.params, results), ctx);
      if (action.as && outcome && typeof outcome === 'object') {
        results[action.as] = outcome as Record<string, unknown>;
      }
      onStep?.({ name: action.action, ok: true, detail: null });
    } catch (error) {
      onStep?.({ name: action.action, ok: false, detail: errorText(error) });
      return `${action.action}: ${errorText(error)}`;
    }
  }
  return null;
}
