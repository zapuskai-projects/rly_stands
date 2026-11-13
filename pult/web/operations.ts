import { api, ApiError } from './api.js';
import { button, card, date, dialog, element, muted, pager, row } from './dom.js';
import { labels, states, type Operation, type Plan } from './types.js';

const tracking = 'stand-panel.operation';
const pending = 'stand-panel.pending';
const key = (name: string, target?: string) => JSON.stringify([name, target]);
let onChange: () => void = () => {};
export function onOperationChange(handler: () => void) { onChange = handler; }

export async function act(name: string, target?: string) {
  const label = labels[name] ?? name;
  const signature = key(name, target);
  const previous = JSON.parse(sessionStorage.getItem(pending) ?? 'null') as { signature: string; id: string } | null;
  const id = previous?.signature === signature ? previous.id : crypto.randomUUID();
  sessionStorage.setItem(pending, JSON.stringify({ signature, id }));
  const body = { action: name, clientRequestId: id, ...(name === 'update.prepare' ? { version: target } : { target }) };
  let plan: Plan;
  try { plan = await api<Plan>('/api/plans', { method: 'POST', body }); }
  catch (error) {
    if (error instanceof ApiError && error.existingOperationId) {
      sessionStorage.setItem(tracking, error.existingOperationId);
      await currentOperation();
      if (error.code === 'REQUEST_COMPLETED') { sessionStorage.removeItem(pending); return; }
    }
    throw error;
  }
  if (!plan.allowed) { sessionStorage.removeItem(pending); throw Error(plan.reason ?? 'Действие сейчас недоступно'); }
  const destructive = ['module.reset', 'task.restart', 'platform.logout'].includes(name);
  const content = element('div', 'stack', plan.targets.length ? muted(plan.targets.join(', ')) : null,
    ...plan.consequences.map((line) => element('p', '', line)));
  const check = element('input');
  check.type = 'checkbox';
  if (destructive) content.append(element('label', 'check', check, ' Подтверждаю указанные последствия'));
  const modal = dialog(label, content, (close) => {
    const submit = button(label, async () => {
      if (destructive && !check.checked) return;
      try {
        sessionStorage.setItem(pending, JSON.stringify({ signature, id, submitted: true }));
        const result = await api<{ operationId: string }>('/api/operations', { method: 'POST',
          body: { planId: plan.planId, ...(plan.confirmationRequired ? { confirmation: { checked: true, token: plan.confirmationToken } } : {}) } });
        sessionStorage.setItem(tracking, result.operationId);
        sessionStorage.removeItem(pending);
        close();
        await currentOperation();
        onChange();
      } catch (error) {
        if (error instanceof ApiError && [403, 409, 410].includes(error.status)) { sessionStorage.removeItem(pending); close(); }
        throw error;
      }
    }, destructive ? 'danger' : 'primary');
    if (destructive) { submit.disabled = true; check.onchange = () => { submit.disabled = !check.checked; }; }
    return [submit];
  });
  modal.querySelector<HTMLButtonElement>('button:last-child')?.focus();
}

export async function currentOperation() {
  let id = sessionStorage.getItem(tracking);
  const intent = JSON.parse(sessionStorage.getItem(pending) ?? 'null') as { id: string; submitted?: boolean } | null;
  if (intent?.submitted) {
    const result = await api<{ operations: Operation[] }>('/api/operations?limit=1&requestId=' + encodeURIComponent(intent.id));
    if (result.operations[0]) {
      id = result.operations[0].id;
      sessionStorage.setItem(tracking, id);
      sessionStorage.removeItem(pending);
    }
  }
  if (!id) return;
  const op = await api<Operation>('/api/operations/' + encodeURIComponent(id));
  if (sessionStorage.getItem(tracking) !== id) return;
  const area = document.querySelector<HTMLElement>('#operation')!;
  const terminal = !['QUEUED', 'RUNNING', 'WAITING_CONFIRMATION'].includes(op.state);
  area.replaceChildren(row(element('b', '', labels[op.action.action] ?? op.action.action), states[op.state] ?? op.state,
    op.error?.message ?? op.stage, button('Подробнее', () => detail(op)), terminal && button('Закрыть', () => { sessionStorage.removeItem(tracking); area.replaceChildren(); })));
  area.className = op.error ? 'notice bad' : 'notice info';
}

function detail(op: Operation) {
  const entries = element('ol');
  for (const e of op.events) entries.append(element('li', '', date(e.at) + ' · ' + e.text));
  const body = element('div', '', muted(op.id), muted(op.error?.message ?? op.result?.message ?? op.stage), entries);
  for (const item of op.result?.diagnostics ?? []) body.append(muted(item.verdict + ' · ' + item.text));
  dialog(labels[op.action.action] ?? op.action.action, body, (close) => [
    op.state === 'WAITING_CONFIRMATION' && op.action.action === 'task.start' && op.action.selector
      ? button('Подготовить заново', async () => { close(); await act('task.restart', op.action.selector); }) : null,
  ]);
}

export async function historyPage(area: HTMLElement, offset = 0) {
  const data = await api<{ operations: Operation[]; total: number }>('/api/operations?offset=' + offset + '&limit=25');
  if (!area.isConnected) return;
  const list = element('div', 'stack');
  for (const op of data.operations) list.append(card(labels[op.action.action] ?? op.action.action,
    muted(date(op.updatedAt) + ' · ' + (states[op.state] ?? op.state)), muted(op.error?.message ?? op.stage), row(
      button('Подробнее', () => detail(op)),
      op.cancelAllowed && button('Отменить', async () => { await api('/api/operations/' + encodeURIComponent(op.id) + '/cancel', { method: 'POST', body: {} }); await historyPage(area, offset); }),
      op.retryAllowed && button('Повторить', () => act(op.action.action, op.action.moduleKey ?? op.action.selector ?? op.action.labId ?? op.action.version)))));
  area.replaceChildren(element('h1', '', 'История'), list, pager(offset, data.total, 25, (page) => historyPage(area, page)),
    button('Обновить историю', () => historyPage(area, offset)));
}

