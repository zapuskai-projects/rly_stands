import { join } from 'node:path';
import { listKitContainers, profileState, type KitContainer } from '../docker/kit-docker';
import { compatibilityRefusal } from '../modules/compatibility';
import { restartModule, startModule, stopModule } from '../modules/lifecycle';
import type { Session, SessionModule } from '../platform/types';
import { fetchScenarioLabel } from '../probes/bank-api';
import { readCurrentTask } from '../store/stores';
import type { ActionContext } from './types';

export type RestartDataDeps = {
  label: () => Promise<string | null>;
  restart: () => Promise<boolean>;
};

export async function restartPreservingData(ctx: ActionContext, module: SessionModule, deps?: RestartDataDeps): Promise<boolean> {
  const { runtime, session, progress } = ctx;
  if (!session) return false;
  if (module.profile !== 'bank') return restartModule(runtime, session, module, progress, undefined, ctx.beforeStep);
  const current = readCurrentTask(runtime.dataDir);
  const context = { workDir: join(runtime.kitDir, 'work'), dataDir: runtime.dataDir, label: current?.label ?? '', results: {} };
  const label = deps?.label ?? (() => fetchScenarioLabel(context));
  const restart = deps?.restart ?? (() => restartModule(runtime, session, module, progress, undefined, ctx.beforeStep));
  let before: string | null | undefined;
  try { before = await label(); } catch { before = undefined; }
  const expected = current?.modules.some((item) => item.key === module.key) ? current.label : before;
  if (!(await restart())) return false;
  const after = await label();
  if (expected !== undefined && after !== expected) {
    progress.fail('Окружение банка после перезапуска не соответствует задаче или прежней метке. Данные сохранены; сброс не выполнялся.');
    return false;
  }
  return true;
}

export async function startAssigned(ctx: ActionContext, modules: SessionModule[]): Promise<boolean> {
  if (!ctx.session) return false;
  const refusal = await compatibilityRefusal(ctx.runtime, ctx.session, modules);
  if (refusal) { ctx.progress.fail(refusal); return false; }
  for (const module of modules) {
    await ctx.beforeStep?.();
    if (!(await startModule(ctx.runtime, ctx.session, module, ctx.progress, { beforeStep: ctx.beforeStep }))) return false;
  }
  return true;
}

export type StopDeps = { containers: () => Promise<KitContainer[]>; stop: (module: SessionModule) => Promise<boolean> };

export function stopAllTargets(session: Session | undefined, containers: KitContainer[]): SessionModule[] {
  return [...new Set(containers.filter((item) => item.running).map((item) => item.profile))].map((profile) => session?.modules.find((module) => module.profile === profile) ?? { key: profile, profile, title: profile, allowed: true, minMemoryMb: 0, reason: null, uis: [] });
}

export async function stopAllOwn(ctx: ActionContext, deps: StopDeps = { containers: listKitContainers, stop: (module) => stopModule(module, ctx.progress) }): Promise<boolean> {
  const containers = await deps.containers();
  return stopAssigned(ctx, stopAllTargets(ctx.session, containers), { ...deps, containers: async () => containers });
}

export async function stopAssigned(ctx: ActionContext, modules: SessionModule[], deps: StopDeps = { containers: listKitContainers, stop: (module) => stopModule(module, ctx.progress) }): Promise<boolean> {
  const containers = await deps.containers();
  let ok = true;
  for (const module of modules) {
    if (profileState(containers, module.profile) === 'stopped') continue;
    await ctx.beforeStep?.();
    if (!(await deps.stop(module))) ok = false;
  }
  return ok;
}
