import { api, ApiError, authenticate, session } from './api.js';
import { badge, button, element, muted, notify, row } from './dom.js';
import { dirty, files, leave } from './files.js';
import { currentOperation, historyPage, onOperationChange } from './operations.js';
import { connection, stands, taskView } from './views.js';
import type { Snapshot } from './types.js';

type Tab = 'task' | 'stands' | 'files' | 'history' | 'connection';
const tabs: Record<Tab, string> = { task: 'Задание', stands: 'Стенды', files: 'Мои файлы', history: 'История', connection: 'Подключение' };
const content = document.querySelector<HTMLElement>('#workspace')!;
const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
const nav = document.querySelector<HTMLElement>('#nav')!;
const status = document.querySelector<HTMLElement>('#connection')!;
let tab: Tab = 'task';
let selected = '';
let snapshot: Snapshot | undefined;
let revision = '';
let polling: Promise<void> | null = null;
let authenticated = false;
let retryAt = 0;

function updateSidebar(s: Snapshot) {
  const list = element('div', 'task-list');
  for (const task of s.tasks) {
    const item = button((task.project?.code ? task.project.code + ' · ' : '') + task.title, () => leave(async () => { selected = task.id; await selectTab('task'); }));
    item.setAttribute('aria-current', String(task.id === selected));
    list.append(item);
  }
  sidebar.replaceChildren(element('h2', '', 'Задания проекта'), list);
}

async function render() {
  if (!snapshot) return;
  const area = element('div', 'stack');
  area.setAttribute('aria-busy', 'true');
  content.replaceChildren(area);
  try {
    if (tab === 'files') await files(area);
    else if (tab === 'history') await historyPage(area);
    else if (tab === 'connection') area.append(connection(snapshot));
    else if (tab === 'stands') area.append(stands(snapshot));
    else area.append(taskView(snapshot, snapshot.tasks.find((t) => t.id === selected)));
  } catch (error) {
    area.replaceChildren(muted(error instanceof Error ? error.message : String(error)), button('Повторить', render));
  } finally { area.removeAttribute('aria-busy'); }
}

async function selectTab(next: Tab) {
  tab = next;
  for (const child of nav.querySelectorAll<HTMLButtonElement>('button')) child.setAttribute('aria-current', String(child.dataset.tab === next));
  if (snapshot) updateSidebar(snapshot);
  await render();
}

for (const [id, title] of Object.entries(tabs)) {
  const item = button(title, () => leave(() => selectTab(id as Tab)));
  item.dataset.tab = id;
  item.setAttribute('aria-current', String(id === tab));
  nav.append(item);
}

function showGate(message: string) {
  sidebar.replaceChildren();
  content.replaceChildren(element('h1', '', 'Вход в локальный пульт'), muted(message),
    muted('Запустите ./stand panel и откройте ссылку, которую он покажет.'), button('Проверить подключение', refresh));
}

async function poll() {
  try {
    const meta = await api<{ uiBuildId: string; apiProtocolVersion: number }>('/api/meta');
    if (meta.uiBuildId !== session.build || meta.apiProtocolVersion !== 1) {
      session.stale = true;
      if (!dirty()) { await currentOperation().catch(() => {}); location.reload(); return; }
      status.replaceChildren(badge('Доступна новая версия'), button('Обновить пульт', () => leave(() => location.reload())));
      return;
    }
    if (!authenticated) { await authenticate(); authenticated = true; }
    const s = await api<Snapshot>('/api/state');
    snapshot = s;
    const fingerprint = JSON.stringify([s.user, s.version, s.policy, s.kit, s.docker?.reachable, s.activeTask,
      s.modules.map((m) => [m.key, m.state, m.reason, m.uis]), s.tasks.map((t) => [t.id, t.title, t.accepted, t.lastCheck.state, t.lastCheck.value]), s.notices]);
    if (!s.tasks.some((t) => t.id === selected)) selected = s.activeTask?.labId ?? s.tasks[0]?.id ?? '';
    status.replaceChildren(badge('Пульт на связи', 'ok'));
    document.querySelector('#version')!.textContent = 'Набор · ' + s.version;
    if (revision !== fingerprint) {
      const initial = !revision;
      revision = fingerprint;
      updateSidebar(s);
      if (initial || !['files', 'history'].includes(tab)) await render();
    }
    await currentOperation();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      authenticated = false;
      revision = '';
      status.replaceChildren(badge('Требуется вход'));
      if (!dirty()) showGate('Сессия истекла или ссылка была открыта без кода входа.');
    } else {
      status.replaceChildren(badge('Нет связи с пультом', 'warn'));
      if (!snapshot) showGate(error instanceof Error ? error.message : 'Контроллер не отвечает');
      if (snapshot && Date.now() > retryAt) { notify('Связь прервана. Пульт проверяет подключение каждые две секунды.'); retryAt = Date.now() + 30000; }
    }
  }
}

function refresh(): Promise<void> {
  if (!polling) polling = poll().finally(() => { polling = null; });
  return polling;
}

onOperationChange(() => { void refresh(); });
window.addEventListener('online', () => { void refresh(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
content.replaceChildren(row(element('div', 'skeleton'), muted('Проверяем состояние пульта…')));
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 2000);

