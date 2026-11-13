import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions } from '../util/version';
import { durableJson, secret } from './durable';
import { PanelError, requireObject, stringField } from './errors';
import type { Controller } from './controller';
import type { Operation } from './types';
import { executeAction } from '../actions/dispatcher';
import { refreshPlatform } from '../actions/session';

export type Handoff = { controllerOnly?: boolean; version: string; oldVersion: string; oldBuild: string; phase: 'prepared' | 'switching' | 'complete' | 'failed'; message?: string };
type Bridge = { pid: string; fingerprint: string; heartbeat: number };

const bridgeFile = (c: Controller) => join(c.runtime.kitDir, '.stand', 'bridge.json');
function owner(c: Controller): Bridge | null {
  const file = bridgeFile(c);
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, 'utf8')) as Bridge;
  if (data.fingerprint !== c.store.fingerprint) throw new PanelError(409, 'KIT_CONFLICT', 'Обработчик запущен из другого набора');
  return data.pid ? data : null;
}

export function checkoutMatches(c: Controller): boolean {
  return readFileSync(join(c.runtime.kitDir, 'VERSION'), 'utf8').trim() === c.runtime.version;
}

export function pendingUpdate(c: Controller): Operation | undefined {
  return c.store.state.operations.find((op) => op.handoff && ['prepared', 'switching'].includes(op.handoff.phase));
}

export function checkCheckout(c: Controller, action: string): void {
  if (['diagnostics.run', 'platform.refresh', 'platform.logout', 'policy.enforce', 'modules.stopAll', 'module.stop'].includes(action)) return;
  if (!checkoutMatches(c) && action !== 'update.prepare') throw new PanelError(409, 'CHECKOUT_CHANGED', 'Версия файлов и пульта различается. Завершите обновление через ./stand panel.');
  if (pendingUpdate(c)) throw new PanelError(409, 'UPDATE_PENDING', 'Для завершения обновления запустите ./stand panel');
}

export function markPrepared(c: Controller, op: Operation, version: string): void {
  op.handoff = { version, oldVersion: c.runtime.version, oldBuild: c.uiBuildId, phase: 'prepared' };
  op.state = 'WAITING_CONFIRMATION';
  op.stage = 'Версия скачана. Для завершения обновления оставьте ./stand panel открытым.';
  op.cancelAllowed = false;
  op.retryAllowed = false;
  delete op.finishedAt;
}

function update(c: Controller, id: string, change: (op: Operation, h: Handoff) => void): void {
  c.store.commit((state) => {
    const op = state.operations.find((item) => item.id === id);
    if (!op?.handoff) throw new PanelError(409, 'HANDOFF_UNKNOWN', 'Запрос на обновление отсутствует');
    change(op, op.handoff);
    op.updatedAt = new Date().toISOString();
  });
}

function adoptCheckout(c: Controller): Operation | undefined {
  const version = readFileSync(join(c.runtime.kitDir, 'VERSION'), 'utf8').trim();
  if (version === c.runtime.version || c.active()) return;
  if (!/^\d+\.\d+\.\d+$/.test(version) || compareVersions(version, c.runtime.version) <= 0) throw new PanelError(409, 'CHECKOUT_VERSION', 'Версия checkout несовместима с работающим пультом');
  if (c.store.state.operations.some((op) => op.handoff?.version === version && op.handoff.phase === 'failed')) return;
  const now = new Date().toISOString();
  const id = secret();
  const op: Operation = { id, requestId: id, payloadHash: '', uiBuildId: c.uiBuildId, state: 'QUEUED', action: { action: 'update.prepare', version },
    targets: [], observedStateBefore: { version: c.runtime.version }, createdAt: now, updatedAt: now, stage: '', events: [], cancelAllowed: false, retryAllowed: false };
  markPrepared(c, op, version);
  op.handoff!.controllerOnly = true;
  c.store.commit((state) => state.operations.push(op));
  return op;
}

export async function bridge(c: Controller, value: unknown): Promise<{ value: string }> {
  const data = requireObject(value, ['verb', 'pid', 'previous', 'id', 'version', 'reason']);
  const verb = stringField(data.verb);
  if (verb === 'version') return { value: c.runtime.version };
  const pid = stringField(data.pid, 16);
  if (!/^[1-9]\d{0,14}$/.test(pid)) throw new PanelError(400, 'BRIDGE_PID', 'Некорректный процесс запуска');
  const current = owner(c);
  if (current && current.pid !== pid) {
    if (verb !== 'reclaim' || data.previous !== current.pid) return { value: 'busy:' + current.pid };
  }
  const heartbeat = (ownerPid: string) => durableJson(bridgeFile(c), { fingerprint: c.store.fingerprint, pid: ownerPid, heartbeat: Date.now() });
  if (verb === 'release') { if (current?.pid === pid) heartbeat(''); return { value: 'idle' }; }
  if (verb === 'tick' || verb === 'reclaim') {
    heartbeat(pid);
    const op = pendingUpdate(c) ?? adoptCheckout(c);
    if (!op?.handoff) return { value: 'idle' };
    if (op.handoff.phase === 'prepared') update(c, op.id, (item, h) => { h.phase = 'switching'; item.stage = 'Замена контроллера. Учебные стенды продолжают работать.'; });
    return { value: op.id + ' ' + op.handoff.version };
  }
  const id = stringField(data.id);
  const version = stringField(data.version);
  const op = c.get(id);
  const handoff = op.handoff;
  if (!current || current.pid !== pid || !handoff || handoff.version !== version) throw new PanelError(409, 'HANDOFF_UNKNOWN', 'Запрос не принадлежит текущему запуску');
  if (handoff.phase === 'complete') return { value: 'complete' };
  if (handoff.phase !== 'switching') throw new PanelError(409, 'HANDOFF_STATE', 'Этап обновления уже завершён');
  if (verb === 'failed') {
    const message = typeof data.reason === 'string' ? data.reason.slice(0, 500) : 'Не удалось заменить пульт';
    update(c, id, (item, h) => { h.phase = 'failed'; h.message = message; item.error = { code: 'UPDATE_FAILED', message }; item.state = 'FAILED'; item.stage = message; item.retryAllowed = true; item.finishedAt = new Date().toISOString(); });
    return { value: 'failed' };
  }
  if (verb !== 'complete' || c.runtime.version !== version || c.uiBuildId === handoff.oldBuild || !c.uiBuildId.startsWith(version + '-') || !checkoutMatches(c)) throw new PanelError(409, 'UPDATE_NOT_READY', 'Новый контроллер и ресурсы панели ещё не готовы');
  if (c.active()) throw new PanelError(409, 'OPERATION_CONFLICT', 'Дождитесь завершения операции');
  return c.control(async () => {
    const context = handoff.controllerOnly ? null : (await refreshPlatform(c.runtime)).context;
    if (!context && !handoff.controllerOnly) throw new PanelError(409, 'SESSION_REQUIRED', 'Для сверки модулей подключите платформу');
    const lines: string[] = [];
    const note = (line: string) => lines.push(c.redactText(line));
    const result = handoff.controllerOnly ? { ok: true } : await executeAction({ runtime: c.runtime, ...context, progress: { ok: note, info: note, fail: note } }, { action: 'update.complete' });
    if (!result.ok) throw new PanelError(409, 'RECONCILE_FAILED', lines.at(-1) ?? 'Не удалось сверить модули');
    update(c, id, (item, h) => {
      h.phase = 'complete'; item.state = 'SUCCEEDED'; item.stage = 'Обновление пульта и интерфейса завершено';
      item.finishedAt = new Date().toISOString(); item.retryAllowed = false; delete item.error;
      item.events.push(...lines.map((text) => ({ text, kind: 'info', at: item.finishedAt! })));
    });
    return { value: 'complete' };
  });
}

