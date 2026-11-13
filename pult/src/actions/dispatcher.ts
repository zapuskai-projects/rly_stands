import { resetModule } from '../modules/lifecycle';
import { compatibilityRefusal } from '../modules/compatibility';
import { defaultReconcileDeps, recreatedAutomatically, staleContainers, updateServiceKey } from '../modules/reconcile';
import { readCurrentTask, writeUpdateMarker } from '../store/stores';
import { findTask } from '../cli/task-render';
import { errorText } from '../probes/errors';
import { enforceAccess } from './access';
import { runDoctor } from './doctor';
import { restartPreservingData, startAssigned, stopAllOwn, stopAssigned } from './modules';
import { actionModules, planAction } from './policy';
import { startProjectFlow } from './project';
import { logoutPlatform, refreshPlatform } from './session';
import { checkFlow, startTaskFlow, verifyFlow } from './tasks';
import { defaultPrepareDeps, prepareUpdate } from './update';
import { reconcileAfterUpdate } from './update-complete';
import type { ActionContext, ActionPlan, ActionRequest, ActionResult } from './types';

export { planAction } from './policy';
export { inspectActionPlan } from './preview';
export type { ActionContext, ActionPlan, ActionRequest, ActionResult } from './types';

export function previewAction(ctx: ActionContext, request: ActionRequest): ActionPlan {
  return planAction(ctx.runtime, ctx.session, request, ctx.stale);
}

export async function executeAction(context: ActionContext, request: ActionRequest): Promise<ActionResult> {
  const ctx = { ...context };
  try {
    if (ctx.revalidate) {
      const fresh = await ctx.revalidate();
      ctx.session = fresh?.session;
      ctx.stale = fresh?.stale;
    }
    if ('selector' in request && ctx.session) request = { ...request, selector: findTask(ctx.session.tasks, request.selector)?.id ?? request.selector };
    const plan = previewAction(ctx, request);
    if (!plan.allowed) { ctx.progress.fail(plan.reason!); return { ok: false, code: plan.code, message: plan.reason }; }
    let confirmed = ctx.confirmed ?? false;
    if (plan.confirmationRequired && !confirmed) {
      confirmed = Boolean(ctx.ask && await ctx.ask(plan.consequences.join(' ')));
      if (!confirmed) return { ok: false, code: 'CONFIRMATION_REQUIRED', message: plan.consequences.join(' ') };
    }
    const boundary = ctx.beforeStep;
    ctx.beforeStep = async () => {
      await boundary?.();
      if (ctx.revalidate) {
        const fresh = await ctx.revalidate();
        ctx.session = fresh?.session;
        ctx.stale = fresh?.stale;
      }
      const policy = previewAction(ctx, request);
      if (!policy.allowed) throw new Error(policy.reason);
    };
    await ctx.beforeStep();
    if (!plan.confirmationRequired) for (const text of plan.consequences) ctx.progress.info(text);
    const { runtime, session, progress } = ctx;
    const modules = session ? actionModules(request, session) : [];
    if (request.action === 'module.start') return { ok: await startAssigned(ctx, modules) };
    if (request.action === 'modules.stopAll') return { ok: await stopAllOwn(ctx) };
    if (request.action === 'module.stop') return { ok: await stopAssigned(ctx, modules) };
    if (request.action === 'module.restart') return { ok: await restartPreservingData(ctx, modules[0]!) };
    if (request.action === 'module.reset') return { ok: await resetModule(modules[0]!, progress) };
    if (request.action === 'project.ensureStarted') {
      const project = await startProjectFlow(runtime, session!, progress, { ask: ctx.ask, showTask: ctx.showTask, say: ctx.say, open: ctx.open, beforeStep: ctx.beforeStep });
      return { ok: project.code === 0, project };
    }
    if (request.action === 'task.start' || request.action === 'task.restart' || request.action === 'task.verify' || request.action === 'task.check') {
      const taskModules = request.action === 'task.check'
        ? session?.modules.filter((module) => readCurrentTask(runtime.dataDir)?.modules.some((item) => item.key === module.key)) ?? []
        : modules;
      if (session) {
        const refusal = await compatibilityRefusal(runtime, session, taskModules);
        if (refusal) { progress.fail(refusal); return { ok: false, code: 'PENDING_MIGRATION', message: refusal }; }
      }
      if (request.action === 'task.check') {
        const current = readCurrentTask(runtime.dataDir);
        if (request.labId && current?.labId !== request.labId) return { ok: false, code: 'TASK_CHANGED', message: 'Активное задание изменилось. Обновите список.' };
        if (current && !session?.tasks.some((task) => task.id === current.labId)) return { ok: false, code: 'TASK_UNAVAILABLE', message: 'Текущая задача больше не назначена' };
        const check = await checkFlow(runtime, progress, ctx.beforeStep);
        return { ok: check?.status === 'PASSED', check };
      }
      if (request.action === 'task.verify') return { ok: await verifyFlow(runtime, session!, request.selector, { ...request, ask: ctx.ask, beforeStep: ctx.beforeStep }, progress) };
      return { ok: await startTaskFlow(runtime, session!, request.selector, progress,
        { force: request.action === 'task.restart', ask: confirmed ? async () => true : ctx.ask, show: ctx.showTask, beforeStep: ctx.beforeStep }) };
    }
    if (request.action === 'diagnostics.run') {
      const diagnostics: NonNullable<ActionResult['diagnostics']> = [];
      const code = await runDoctor(runtime, (verdict, text) => { diagnostics.push({ verdict, text }); ctx.diagnostic?.(verdict, text); });
      return { ok: code === 0, diagnostics };
    }
    if (request.action === 'platform.refresh') {
      const refreshed = await refreshPlatform(runtime);
      return { ok: refreshed.context !== null, sessionContext: refreshed.context, code: refreshed.result.ok ? undefined : `PLATFORM_${refreshed.result.kind.toUpperCase()}`, message: refreshed.result.ok ? undefined : refreshed.result.message };
    }
    if (request.action === 'platform.logout') { logoutPlatform(runtime); return { ok: true }; }
    if (request.action === 'policy.enforce') { await enforceAccess(runtime, progress.info); return { ok: true }; }
    if (request.action === 'update.prepare') {
      const version = request.version;
      if (version !== session!.kit.latestVersion && version !== session!.kit.minVersion) return { ok: false, code: 'VERSION_UNAVAILABLE' };
      const changes = await staleContainers(defaultReconcileDeps(runtime, progress), version);
      if (!changes) return { ok: false, code: 'DOCKER_UNKNOWN' };
      const approved = changes.map(updateServiceKey).sort();
      if (ctx.approvedUpdates && JSON.stringify(ctx.approvedUpdates) !== JSON.stringify(approved)) return { ok: false, code: 'PLAN_STALE', message: 'Состав обновления изменился; запросите новый план' };
      return { ok: await prepareUpdate(version, runtime.version, progress, defaultPrepareDeps(version,
        async () => changes.filter(recreatedAutomatically),
        (accepted, profiles) => writeUpdateMarker(runtime.dataDir, accepted, profiles, approved))) };
    }
    return { ok: await reconcileAfterUpdate(runtime, session!, progress, ctx.reconcileDeps) };
  } catch (error) {
    const message = errorText(error);
    ctx.progress.fail(message);
    return { ok: false, code: 'ACTION_FAILED', message };
  }
}

export async function dispatchAction(context: ActionContext, request: ActionRequest): Promise<ActionResult> {
  const { routeAction } = await import('../panel/gateway.js');
  return routeAction(context, request);
}
