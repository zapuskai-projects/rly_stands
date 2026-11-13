import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeAction } from '../actions/dispatcher';
import type { ActionContext, ActionRequest, ActionResult } from '../actions/types';
import { rememberLogin, refreshPlatform } from '../actions/session';
import { readCurrentTask, takeNotices } from '../store/stores';
import type { Runtime } from '../config';
import type { Session } from '../platform/types';
import { acquireWriter } from './mutex';
import { PanelError } from './errors';
import type { Operation, PanelPlan } from './types';
import { secret } from './durable';
import { kitFingerprint } from './store';
import { internalTimeout, longInternalCall } from './internal-http';

export async function internalCall(runtime: Runtime, path: string, body?: unknown): Promise<unknown> {
  const key = readFileSync(join(runtime.dataDir, 'panel', 'internal-key'), 'utf8').trim();
  const timeoutMs = internalTimeout(path, body);
  if (timeoutMs > 300000) return longInternalCall(path, body, key, timeoutMs);
  const response = await fetch(`http://stands-kit-panel:18490${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Panel-Key': key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const result = await response.json() as { error?: { code: string; message: string; details?: unknown } };
  if (!response.ok) throw new PanelError(response.status, result.error?.code ?? 'CONTROLLER_ERROR', result.error?.message ?? 'Контроллер недоступен', result.error?.details);
  return result;
}

function markerExists(runtime: Runtime): boolean {
  for (const name of ['state.json', 'controller.json']) {
    const path = join(runtime.dataDir, 'panel', name);
    if (!existsSync(path)) continue;
    let stored: { fingerprint?: string };
    try { stored = JSON.parse(readFileSync(path, 'utf8')) as { fingerprint?: string }; } catch { throw new PanelError(503, 'JOURNAL_INVALID', 'Не удалось прочитать владельца данных пульта'); }
    if (stored.fingerprint !== kitFingerprint(runtime)) throw new PanelError(409, 'KIT_CONFLICT', 'Контроллер и данные принадлежат другой папке набора');
  }
  return existsSync(join(runtime.dataDir, 'panel', 'controller.json'));
}

export async function routeAction(context: ActionContext, request: ActionRequest): Promise<ActionResult> {
  try {
    if (markerExists(context.runtime)) {
      let reached = false;
      try {
        await internalCall(context.runtime, '/internal/meta'); reached = true;
        if (request.action === 'policy.enforce') { await internalCall(context.runtime, '/internal/policy', {}); return { ok: true }; }
        const plan = await internalCall(context.runtime, '/internal/plan', { request, clientRequestId: secret() }) as PanelPlan;
        if (!plan.allowed) return { ok: false, code: plan.code, message: plan.reason };
        let checked = context.confirmed ?? false;
        if (plan.confirmationRequired && !checked) checked = Boolean(context.ask && await context.ask(plan.consequences.join(' ')));
        if (plan.confirmationRequired && !checked) return { ok: false, code: 'CONFIRMATION_REQUIRED', message: plan.consequences.join(' ') };
        const accepted = await internalCall(context.runtime, '/internal/operation', { planId: plan.planId, ...(plan.confirmationRequired ? { confirmation: { checked: true, token: plan.confirmationToken } } : {}) }) as { operationId: string };
        context.progress.info(`Операция ${accepted.operationId}`);
        let count = 0;
        for (;;) {
          const op = await internalCall(context.runtime, `/internal/operations/${encodeURIComponent(accepted.operationId)}`) as Operation;
          for (const event of op.events.slice(count)) context.progress[event.kind === 'error' ? 'fail' : event.kind === 'ok' ? 'ok' : 'info'](event.text);
          count = op.events.length;
          if (!['QUEUED', 'RUNNING'].includes(op.state)) {
            if (op.result?.ok && ['task.start', 'task.restart', 'project.ensureStarted'].includes(request.action)) { const task = readCurrentTask(context.runtime.dataDir); if (task) context.showTask?.(task); }
            return op.result ?? { ok: false, code: op.error?.code ?? op.state, message: op.error?.message ?? op.stage };
          }
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      } catch (error) {
        if (error instanceof PanelError || reached) throw error;
        context.progress.info('Контроллер не отвечает; проверяю блокировку записи');
      }
    }
    const release = await acquireWriter(context.runtime.dataDir);
    try { return await executeAction({ ...context, revalidate: context.revalidate ?? (context.session ? async () => (await refreshPlatform(context.runtime)).context : undefined) }, request); } finally { await release(); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    context.progress.fail(message);
    return { ok: false, code: error instanceof PanelError ? error.code : 'CONTROLLER_UNAVAILABLE', message };
  }
}

export async function routeLogin(runtime: Runtime, token: string, session: Session | null): Promise<void> {
  if (markerExists(runtime)) {
    try { await internalCall(runtime, '/internal/login', { token, session }); return; } catch (error) { if (error instanceof PanelError) throw error; }
  }
  const release = await acquireWriter(runtime.dataDir);
  try { rememberLogin(runtime, token, session); } finally { await release(); }
}

export async function routeNotices(runtime: Runtime) {
  if (markerExists(runtime)) {
    try { return await internalCall(runtime, '/internal/notices', {}) as ReturnType<typeof takeNotices>; } catch (error) { if (error instanceof PanelError) throw error; }
  }
  const release = await acquireWriter(runtime.dataDir);
  try { return takeNotices(runtime.dataDir); } finally { await release(); }
}
