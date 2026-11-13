import { checkCheckout, markPrepared } from './handoff';
import { createHmac } from 'node:crypto';
import type { Runtime } from '../config';
import { executeAction, inspectActionPlan } from '../actions/dispatcher';
import { refreshPlatform } from '../actions/session';
import type { ActionContext, ActionPlan, ActionRequest, ActionResult } from '../actions/types';
import { readBankSecret, readConfig } from '../store/stores';
import { digest, secret } from './durable';
import { PanelError } from './errors';
import { cachedContext, observe, stateRevision } from './snapshot';
import { PanelStore } from './store';
import type { Operation, PanelPlan } from './types';

export type ControllerDeps = {
  refresh: typeof refreshPlatform;
  preview: typeof inspectActionPlan;
  observe: typeof observe;
  execute: typeof executeAction;
};
const defaults: ControllerDeps = { refresh: refreshPlatform, preview: inspectActionPlan, observe, execute: executeAction };

function policyHash(plan: ActionPlan): string {
  return digest([plan.allowed, plan.code, plan.reason, plan.targets, plan.consequences, plan.confirmationRequired, plan.approvedUpdates]);
}

export class Controller {
  readonly store: PanelStore;
  private pendingPolicy = false;
  private policyRunning = false;
  private failure: unknown;
  private controlBusy = false;
  constructor(readonly runtime: Runtime, readonly uiBuildId: string, private deps: ControllerDeps = defaults) { this.store = new PanelStore(runtime); }
  redactText(value: string): string {
    const config = readConfig(this.runtime.dataDir);
    let text = value.replace(/sk_[A-Za-z0-9_-]+/g, '[скрыто]');
    for (const key of [config.token, readBankSecret(this.runtime.dataDir), this.store.key, this.store.internalKey]) if (key) text = text.split(key).join('[скрыто]');
    return text.slice(0, 4000);
  }
  assertHealthy(): void { if (this.failure) throw new PanelError(503, 'JOURNAL_UNAVAILABLE', 'Запись журнала недоступна; действия остановлены'); }
  async control<T>(action: () => Promise<T>): Promise<T> {
    this.assertHealthy();
    if (this.controlBusy || this.active() || this.policyRunning) throw new PanelError(409, 'OPERATION_CONFLICT', 'Дождитесь текущего действия', { existingOperationId: this.active()?.id });
    this.controlBusy = true;
    try { return await action(); } finally { this.controlBusy = false; }
  }
  isWriting(): boolean { return Boolean(this.active() || this.controlBusy || this.policyRunning); }
  active(): Operation | undefined { return this.store.state.operations.find((op) => ['QUEUED', 'RUNNING'].includes(op.state)); }
  private context(): ActionContext {
    const current = cachedContext(this.runtime);
    return { runtime: this.runtime, session: current?.session, stale: current?.stale, progress: { info: () => undefined, ok: () => undefined, fail: () => undefined } };
  }
  async plan(request: ActionRequest, requestId: string): Promise<PanelPlan> {
    this.assertHealthy();
    const existing = Object.values(this.store.state.plans).find((plan) => plan.clientRequestId === requestId);
    if (existing && digest(existing.payload) !== digest(request)) throw new PanelError(409, 'REQUEST_CONFLICT', 'Этот requestId уже использован для другого действия');
    if (existing) return existing;
    const tombstone = this.store.state.tombstones[requestId];
    if (tombstone) throw new PanelError(409, 'REQUEST_COMPLETED', 'Действие уже принято; прочитайте его состояние', { existingOperationId: tombstone.operationId });
    if (!this.active() && !this.policyRunning) await this.deps.refresh(this.runtime);
    checkCheckout(this, request.action);
    const policy = await this.deps.preview(this.context(), request);
    const observed = await this.deps.observe(this.runtime);
    const plan: PanelPlan = { ...policy, planId: secret(), clientRequestId: requestId, expiresAt: new Date(Date.now() + 120000).toISOString(), payload: request, kitFingerprint: this.store.fingerprint, uiBuildId: this.uiBuildId, revision: digest(observed), signature: '', ...(policy.confirmationRequired ? { confirmationToken: secret() } : {}) };
    plan.signature = createHmac('sha256', this.store.key).update(JSON.stringify({ ...plan, signature: '' })).digest('hex');
    this.store.commit((state) => { state.plans[plan.planId] = plan; });
    return plan;
  }
  async submit(planId: string, confirmation?: { checked: boolean; token: string }): Promise<string> {
    this.assertHealthy();
    const already = this.store.state.tombstones[`plan:${planId}`];
    if (already) return already.operationId;
    const plan = this.store.state.plans[planId];
    if (!plan || Date.parse(plan.expiresAt) < Date.now()) throw new PanelError(410, 'PLAN_EXPIRED', 'План истёк; запросите новый просмотр');
    const signature = createHmac('sha256', this.store.key).update(JSON.stringify({ ...plan, signature: '' })).digest('hex');
    if (signature !== plan.signature || plan.kitFingerprint !== this.store.fingerprint || plan.uiBuildId !== this.uiBuildId) throw new PanelError(409, 'PLAN_STALE', 'План изменился');
    if (!plan.allowed) throw new PanelError(409, plan.code ?? 'ACTION_DENIED', plan.reason ?? 'Действие недоступно');
    checkCheckout(this, plan.payload.action);
    const busy = this.active();
    if (busy || this.policyRunning) throw new PanelError(409, 'OPERATION_CONFLICT', 'Дождитесь текущего действия', { existingOperationId: busy?.id });
    await this.deps.refresh(this.runtime);
    const policy = await this.deps.preview(this.context(), plan.payload);
    const observed = await this.deps.observe(this.runtime);
    if (digest(observed) !== plan.revision || policyHash(policy) !== policyHash(plan)) throw new PanelError(409, 'PLAN_STALE', 'Состояние или права изменились; запросите новый просмотр');
    if (plan.confirmationRequired && (!confirmation?.checked || confirmation.token !== plan.confirmationToken || this.store.state.consumed.includes(planId))) throw new PanelError(409, 'CONFIRMATION_REQUIRED', 'Нужно явное подтверждение этого плана');
    const id = secret(); const now = new Date().toISOString();
    const op: Operation = { id, requestId: plan.clientRequestId, payloadHash: digest(plan.payload), uiBuildId: this.uiBuildId, action: plan.payload, targets: plan.targets, state: 'QUEUED', stage: 'Ожидает запуска', createdAt: now, updatedAt: now, observedStateBefore: observed, cancelAllowed: true, retryAllowed: false, confirmation: planId, events: [] };
    this.store.commit((state) => {
      state.operations.push(op);
      state.tombstones[op.requestId] = { operationId: id, payloadHash: op.payloadHash, at: Date.now() };
      state.tombstones[`plan:${planId}`] = state.tombstones[op.requestId]!;
      if (plan.confirmationRequired) state.consumed.push(planId);
    });
    setImmediate(() => { void this.run(id).catch((error: unknown) => { this.failure = error; }); });
    return id;
  }
  private change(id: string, change: (operation: Operation) => void): void {
    this.store.commit((state) => { const op = state.operations.find((item) => item.id === id); if (op) { change(op); op.updatedAt = new Date().toISOString(); } });
  }
  get(id: string): Operation {
    const op = this.store.state.operations.find((item) => item.id === id);
    if (!op) throw new PanelError(404, 'OPERATION_UNKNOWN', 'Операция не найдена; проверьте фактическое состояние');
    return op;
  }
  cancel(id: string): Operation {
    const op = this.get(id);
    if (op.state !== 'QUEUED') throw new PanelError(409, 'CANCEL_UNSAFE', 'Действие уже началось; безопасная отмена недоступна');
    this.change(id, (item) => { item.state = 'CANCELLED'; item.cancelAllowed = false; item.finishedAt = new Date().toISOString(); });
    return this.get(id);
  }
  private async run(id: string): Promise<void> {
    const op = this.get(id);
    if (op.state !== 'QUEUED') return;
    this.change(id, (item) => { item.state = 'RUNNING'; item.cancelAllowed = false; item.startedAt = new Date().toISOString(); item.stage = 'Проверка доступа'; });
    const plan = this.store.state.plans[op.confirmation!]!;
    let awaiting = false;
    const event = (kind: string, text: string) => this.change(id, (item) => { item.stage = this.redactText(text); item.events.push({ at: new Date().toISOString(), kind, text: item.stage }); item.events = item.events.slice(-200); });
    const ctx = this.context();
    ctx.confirmed = plan.confirmationRequired;
    ctx.approvedUpdates = plan.approvedUpdates;
    ctx.progress = { info: (text) => event('info', text), ok: (text) => event('ok', text), fail: (text) => event('error', text) };
    ctx.ask = async (text) => { awaiting = true; event('confirmation', text); return false; };
    ctx.say = (text) => { if (text) event('info', text); };
    ctx.revalidate = async () => {
      if (this.pendingPolicy) { this.pendingPolicy = false; await this.deps.execute({ runtime: this.runtime, progress: ctx.progress }, { action: 'policy.enforce' }); }
      return (await this.deps.refresh(this.runtime)).context;
    };
    ctx.beforeStep = async () => { this.assertHealthy(); event('stage', 'Проверка прав перед следующим шагом'); };
    let result: ActionResult;
    try {
      const current = await this.deps.observe(this.runtime);
      checkCheckout(this, op.action.action);
      if (digest(current) !== plan.revision) result = { ok: false, code: 'PLAN_STALE', message: 'Состояние изменилось до начала действия' };
      else result = await this.deps.execute(ctx, op.action);
      const after = await this.deps.observe(this.runtime);
      this.change(id, (item) => {
        item.observedStateAfter = after;
        item.result = JSON.parse(this.redactJson(result)) as ActionResult;
        item.state = awaiting ? 'WAITING_CONFIRMATION' : result.ok ? 'SUCCEEDED' : 'FAILED';
        item.stage = awaiting ? 'Нужно отдельное подтверждение нового плана' : result.ok ? 'Готово' : this.redactText(result.message ?? 'Действие не завершено');
        item.retryAllowed = !result.ok; item.finishedAt = new Date().toISOString();
        if (result.ok && item.action.action === 'update.prepare') markPrepared(this, item, item.action.version);
        if (!result.ok) item.error = { code: result.code ?? 'ACTION_FAILED', message: item.stage };
      });
    } catch (error) {
      this.change(id, (item) => { item.state = 'INTERRUPTED'; item.retryAllowed = true; item.error = { code: 'INTERRUPTED', message: this.redactText(error instanceof Error ? error.message : String(error)) }; item.stage = 'Проверить состояние'; });
    }
    if (this.pendingPolicy) await this.enforce();
  }
  private redactJson(value: unknown): string {
    return JSON.stringify(value, (_key, field: unknown) => typeof field === 'string' ? this.redactText(field) : field);
  }
  async enforce(): Promise<void> {
    if (this.active() || this.policyRunning || this.controlBusy) { this.pendingPolicy = true; return; }
    this.assertHealthy(); this.policyRunning = true;
    try { await this.deps.execute(this.context(), { action: 'policy.enforce' }); } finally { this.policyRunning = false; }
  }
  async ensureStarted(): Promise<void> {
    if (this.store.state.startupDone || !cachedContext(this.runtime) || this.active()) return;
    this.store.commit((state) => { state.startupDone = true; });
    await this.control(async () => {
      const plan = await this.plan({ action: 'project.ensureStarted' }, `startup-${secret()}`);
      if (plan.allowed) await this.submit(plan.planId);
    });
  }
  async reconcileInterrupted(): Promise<void> {
    const after = await this.deps.observe(this.runtime);
    this.store.commit((state) => { for (const op of state.operations) if (op.state === 'INTERRUPTED') op.observedStateAfter = after; });
  }
  revision(): string { return stateRevision(this.runtime); }
}
