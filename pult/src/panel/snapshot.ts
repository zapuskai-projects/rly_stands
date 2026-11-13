import { join } from 'node:path';
import type { Runtime } from '../config';
import { listKitContainers, profileState, type KitContainer } from '../docker/kit-docker';
import { readConfig, readCurrentTask, readNotices } from '../store/stores';
import { fetchTaskState, type KitTaskState } from '../platform/client';
import { fetchScenarioLabel } from '../probes/bank-api';
import { digest } from './durable';
import { ticketUrl } from '../actions/project';
import type { PanelStore } from './store';
import type { Session, SessionModule, SessionTask } from '../platform/types';
import { requiredModules } from '../modules/requires';

export function cachedContext(runtime: Runtime) {
  const config = readConfig(runtime.dataDir);
  const since = config.lastOkAt ? Date.parse(config.lastOkAt) : 0;
  if (!config.token || !config.session || Date.parse(config.session.token.expiresAt) <= Date.now() || Date.now() - since > config.session.kit.offlineGraceHours * 3600000) return null;
  return { session: config.session, stale: Date.now() - since > 30000 };
}
export const stateRevision = (runtime: Runtime): string => {
  const config = readConfig(runtime.dataDir);
  return digest({ version: runtime.version, session: config.session, token: Boolean(config.token), task: readCurrentTask(runtime.dataDir) });
};
export const activeTaskSummary = (runtime: Runtime) => { const task = readCurrentTask(runtime.dataDir); return task ? { labId: task.labId, attemptId: task.attemptId, title: task.title, label: task.label, seeded: task.seeded } : null; };
export async function observe(runtime: Runtime) {
  let modules: unknown = { state: 'unknown', reason: 'Docker не ответил' };
  try { modules = await listKitContainers(); } catch {}
  let scenario: unknown = { state: 'unknown', reason: 'Активный сценарий недоступен' };
  if (readConfig(runtime.dataDir).session?.modules.some((module) => module.profile === 'bank')) {
    try { scenario = { state: 'known', label: await fetchScenarioLabel({ workDir: join(runtime.kitDir, 'work'), dataDir: runtime.dataDir, label: '' }) }; } catch {}
  }
  return { revision: stateRevision(runtime), activeTask: activeTaskSummary(runtime), modules, scenario };
}
const safeUrl = (value: string): string | null => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null; } catch { return null; } };
export function taskAccepted(task: SessionTask): boolean {
  return task.project ? task.project.state === 'DONE' : task.status === 'PASSED';
}
export function observedModule(module: SessionModule, session: Session, containers: KitContainer[] | null): { state: 'running' | 'partial' | 'stopped' | 'unknown'; stateReason: string | null } {
  if (!containers) return { state: 'unknown', stateReason: 'Docker не ответил: состояние неизвестно' };
  const state = profileState(containers, module.profile);
  if (state !== 'running') return { state, stateReason: state === 'partial' ? 'Часть контейнеров стенда не работает' : null };
  const queue = [module]; const seen = new Set<string>(); const unavailable = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    if (seen.has(current.key)) continue;
    seen.add(current.key);
    const required = requiredModules(session, current);
    required.missing.forEach((key) => unavailable.add(key));
    for (const dependency of required.modules) {
      if (profileState(containers, dependency.profile) !== 'running') unavailable.add(dependency.title);
      queue.push(dependency);
    }
  }
  return unavailable.size ? { state: 'partial', stateReason: `Не работают зависимости: ${[...unavailable].join(', ')}` } : { state: 'running', stateReason: null };
}
export class Snapshots {
  private cache = new Map<string, { checkedAt: string; value?: KitTaskState; state: string; reason?: string }>();
  private inflight?: Promise<unknown>;
  private identity = '';
  constructor(private runtime: Runtime, private store: PanelStore) {}
  async get(): Promise<PanelSnapshot> {
    const runtime = this.runtime;
    const config = readConfig(runtime.dataDir);
    const identity = digest({ token: config.token, user: config.session?.user });
    if (identity !== this.identity) { this.cache.clear(); this.identity = identity; this.inflight = undefined; }
    const context = cachedContext(runtime);
    const session = context?.session;
    let containers: Awaited<ReturnType<typeof listKitContainers>> | null = null;
    try { containers = await listKitContainers(); } catch {}
    const checkedAt = new Date().toISOString();
    if (!this.inflight && config.token && session) {
      const due = session.tasks.filter((task) => !this.cache.has(task.id) || Date.now() - Date.parse(this.cache.get(task.id)!.checkedAt) > 10000);
      this.inflight = Promise.all(due.map(async (task) => {
        const previous = this.cache.get(task.id);
        const result = await fetchTaskState({ platformUrl: config.platformUrl ?? runtime.platformUrl, token: config.token!, kitVersion: runtime.version }, task.id);
        if (this.identity !== identity) return;
        this.cache.set(task.id, result.ok ? { state: 'known', checkedAt: new Date().toISOString(), value: result.value } : { ...previous, state: previous?.value ? 'stale' : 'unknown', checkedAt: previous?.checkedAt ?? new Date().toISOString(), reason: result.status === 401 ? 'Нужно переподключение к платформе' : result.message });
      })).finally(() => { if (this.identity === identity) this.inflight = undefined; });
    }
    await this.inflight;
    const freshConfig = readConfig(runtime.dataDir);
    if (identity !== digest({ token: freshConfig.token, user: freshConfig.session?.user })) return this.get();
    return {
      revision: this.store.state.revision, serverRevision: stateRevision(runtime), checkedAt,
      version: runtime.version, kit: session?.kit ?? null, docker: { reachable: containers !== null, checkedAt }, scenario: (await observe(runtime)).scenario, user: session?.user ?? null, projects: session?.projects ?? [],
      tasks: (session?.tasks ?? []).map((task) => ({ ...task, url: ticketUrl(session!, task) ? safeUrl(ticketUrl(session!, task)!) : null, accepted: taskAccepted(task), lastCheck: this.cache.get(task.id) ?? { state: 'unknown', reason: 'Результат ещё не получен', checkedAt: null } })),
      modules: (session?.modules ?? []).map((module) => { const status = observedModule(module, session!, containers); return { ...module, uis: module.uis.flatMap((ui) => safeUrl(ui.url) ? [ui] : []), ...status, reason: status.stateReason ?? module.reason, checkedAt }; }),
      activeTask: activeTaskSummary(runtime), policy: { connected: Boolean(config.token), stale: context?.stale ?? true, allowed: Boolean(context), lastOkAt: config.lastOkAt, offlineGraceHours: config.session?.kit.offlineGraceHours ?? null, reason: context ? null : 'Нужна связь с платформой или новое подключение' },
      notices: readNotices(runtime.dataDir), queue: this.store.state.operations.filter((op) => ['QUEUED', 'RUNNING', 'WAITING_CONFIRMATION'].includes(op.state)),
    };
  }
}

export type PanelSnapshot = { revision: number; serverRevision: string; checkedAt: string; version: string; kit: import('../platform/types').Session['kit'] | null; docker: { reachable: boolean; checkedAt: string }; scenario: unknown; user: unknown; projects: unknown[]; tasks: unknown[]; modules: unknown[]; activeTask: ReturnType<typeof activeTaskSummary>; policy: { connected: boolean; stale: boolean; allowed: boolean; lastOkAt: string | null; offlineGraceHours: number | null; reason: string | null }; notices: ReturnType<typeof readNotices>; queue: import('./types').Operation[] };
