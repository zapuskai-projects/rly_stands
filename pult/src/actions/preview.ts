import { defaultReconcileDeps, manualUpdateNote, recreatedAutomatically, staleContainers, updateServiceKey } from '../modules/reconcile';
import { listKitContainers, memoryTotalMb, profileState, type KitContainer } from '../docker/kit-docker';
import { compatibilityRefusal } from '../modules/compatibility';
import { checkMemory, memoryRefusal } from '../modules/memory';
import type { SessionModule } from '../platform/types';
import { stopAllTargets } from './modules';
import { actionModules, planAction } from './policy';
import type { ActionContext, ActionPlan, ActionRequest } from './types';

export type PreviewDeps = {
  containers: () => Promise<KitContainer[]>;
  memory: () => Promise<number | null>;
  compatible: (modules: SessionModule[]) => Promise<string | null>;
};

export async function inspectActionPlan(ctx: ActionContext, request: ActionRequest, deps: PreviewDeps = {
  containers: listKitContainers,
  memory: () => memoryTotalMb(ctx.runtime),
  compatible: (modules) => compatibilityRefusal(ctx.runtime, ctx.session!, modules),
}): Promise<ActionPlan> {
  const plan = planAction(ctx.runtime, ctx.session, request, ctx.stale);
  if (request.action === 'modules.stopAll' && plan.allowed) {
    try { return { ...plan, targets: stopAllTargets(ctx.session, await deps.containers()).map((module) => module.key) }; }
    catch { return { ...plan, allowed: false, code: 'DOCKER_UNKNOWN', reason: 'Docker не ответил: состояние стендов неизвестно' }; }
  }
  if (!plan.allowed || !ctx.session) return plan;
  if (request.action === 'update.prepare') {
    const stale = await staleContainers(defaultReconcileDeps(ctx.runtime, ctx.progress), request.version);
    if (!stale) return { ...plan, allowed: false, reason: 'Не удалось проверить работающие образы Docker' };
    return { ...plan, approvedUpdates: stale.map(updateServiceKey).sort(), confirmationRequired: true, targets: stale.map((item) => item.wanted.container).sort(),
      consequences: ['При замене пульта на короткое время прервётся связь с вкладкой.', ...stale.map((item) =>
        recreatedAutomatically(item) ? `Обновится ${item.wanted.container} до ${item.wanted.image}; тома сохранятся.` : manualUpdateNote(ctx.session!, item)).sort()] };
  }
  if (!['module.start', 'module.restart', 'project.ensureStarted', 'task.start', 'task.restart', 'task.check'].includes(request.action)) return plan;
  const session = ctx.session;
  const modules = actionModules(request, session);
  const selected = session.modules.filter((module) => plan.targets.includes(module.key));
  try {
    const refusal = await deps.compatible(modules);
    if (refusal) return { ...plan, allowed: false, code: 'PENDING_MIGRATION', reason: refusal };
    const containers = await deps.containers();
    if (request.action === 'task.check') return plan;
    const total = await deps.memory();
    if (total === null) return { ...plan, allowed: false, code: 'DOCKER_UNKNOWN', reason: 'Не удалось определить память Docker; состояние неизвестно' };
    const running = session.modules.filter((module) => profileState(containers, module.profile) !== 'stopped');
    for (const module of selected) {
      if (running.some((item) => item.key === module.key)) continue;
      const verdict = checkMemory(total, running, module, selected.map((item) => item.key));
      if (!verdict.ok) return { ...plan, allowed: false, code: 'MEMORY_REQUIRED', reason: memoryRefusal(verdict) };
      running.push(module);
    }
    return plan;
  } catch {
    return { ...plan, allowed: false, code: 'DOCKER_UNKNOWN', reason: 'Docker не ответил: состояние стендов неизвестно' };
  }
}
