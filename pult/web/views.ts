import { api } from './api.js';
import { badge, button, card, date, dialog, element, link, muted, row } from './dom.js';
import { act } from './operations.js';
import { labels, states, type Module, type Snapshot, type Task } from './types.js';

const action = (name: string, target?: string, style = '') => button(labels[name], () => act(name, target), style);

function moduleCard(mod: Module) {
  const tools = element('details', '', element('summary', '', 'Действия и журнал'));
  const logs = button('Журнал контейнеров', async () => {
    const output = await api<{ logs: { name: string; text: string; available: boolean }[] }>('/api/modules/' + encodeURIComponent(mod.key) + '/logs');
    dialog('Журнал · ' + mod.title, element('pre', '', output.logs.map((l) => l.name + '\n' + (l.available ? l.text : 'Журнал недоступен')).join('\n\n') || 'Записей пока нет'), () => []);
  });
  const stopped = mod.state === 'stopped';
  const manage = mod.allowed && mod.state !== 'unknown';
  tools.append(row(logs, manage && action('module.reset', mod.key)));
  return card(mod.title, row(badge(states[mod.state] ?? mod.state, mod.state === 'running' ? 'ok' : ''), muted(date(mod.checkedAt))),
    mod.requires?.length ? muted('Зависимости · ' + mod.requires.join(', ')) : null,
    mod.reason ? muted(mod.reason) : null, mod.state === 'unknown' ? muted('Для управления проверьте соединение с Docker.') : null,
    row(...mod.uis.map((ui) => link(ui.title, ui.url))),
    row(manage && action(stopped ? 'module.start' : 'module.restart', mod.key), !stopped && mod.state !== 'unknown' && action('module.stop', mod.key)), tools);
}

export function stands(s: Snapshot) {
  return element('div', 'stack', row(element('h1', '', 'Стенды'), s.modules.length > 0 && action('project.ensureStarted', undefined, 'primary'), s.modules.length > 0 && action('modules.stopAll')),
    s.modules.length ? element('div', 'grid', ...s.modules.map(moduleCard)) : card('Нет назначенных стендов', muted(s.policy.reason ?? 'Назначения выдаёт учебная платформа.'), action('platform.refresh')));
}

export function taskView(s: Snapshot, task?: Task) {
  if (!task) return element('div', 'stack', element('h1', '', 'Задание'), card('Пока нет заданий', muted(s.policy.reason ?? 'Проверьте назначения проекта.'), action('platform.refresh')));
  const active = s.activeTask?.labId === task.id;
  const outcome = task.lastCheck.value?.result;
  const results = element('details', '', element('summary', '', 'Результаты по пунктам'));
  for (const result of outcome?.assertionResults ?? []) results.append(card(result.title,
    badge(result.unavailable ? 'Проверка недоступна' : result.passed ? 'Пройдено' : 'Не пройдено', result.passed ? 'ok' : 'warn'),
    result.detail ? muted(result.detail) : null, result.hint ? muted(result.hint) : null));
  const linked = s.modules.filter((m) => task.modules.some((t) => t.key === m.key));
  return element('div', 'stack', row(element('h1', '', task.title), task.project && badge(task.project.code)),
    card('Работа над заданием', row(badge(task.accepted ? 'Зачтено' : 'Зачёта пока нет', task.accepted ? 'ok' : ''), active && badge('Активный сценарий')),
      !active && s.activeTask && muted('Сейчас активно другое задание · ' + s.activeTask.title),
      row(active ? action('task.check', task.id, 'primary') : action('task.start', task.id, 'primary'), link('Открыть на платформе', task.url)),
      element('details', '', element('summary', '', 'Подготовка сценария'), action('task.restart', task.id))),
    card('Последняя проверка', task.lastCheck.state !== 'known' && muted(task.lastCheck.reason ?? 'Нет связи с платформой'),
      outcome ? muted(outcome.message ?? 'Данные получены с платформы') : muted('Результат проверки ещё не получен.'),
      outcome?.summary && badge(`${outcome.summary.passed} из ${outcome.summary.total}`),
      outcome?.detail && muted(outcome.detail), outcome?.assertionResults?.length ? results : null),
    card('Стенды задания', linked.length ? element('div', 'grid', ...linked.map(moduleCard)) : muted('Для задания не назначены локальные стенды.')));
}

type Device = { id: string; code: string; verifyUrl?: string; expiresAt: string; status: string; message?: string; intervalSec?: number };
async function login() {
  const data = await api<Device>('/api/device-login', { method: 'POST', body: {} });
  const status = muted('Ожидаем подтверждение');
  const modal = dialog('Подключить платформу', element('div', 'stack', muted('Введите этот код на платформе'), element('strong', 'device-code', data.code),
    link('Открыть платформу', data.verifyUrl), muted('Код действует до ' + date(data.expiresAt)), status), () => []);
  const poll = async () => {
    if (!modal.open) return;
    try {
      const next = await api<Device>('/api/device-login/' + encodeURIComponent(data.id));
      const pending = next.status.toUpperCase() === 'PENDING';
      status.textContent = next.message ?? ({ APPROVED: 'Платформа подключена', DENIED: 'Вход отклонён', EXPIRED: 'Срок действия кода истёк', PENDING: 'Ожидаем подтверждение' }[next.status.toUpperCase()] ?? next.status);
      if (!pending) return;
    } catch { status.textContent = 'Проверяем связь с платформой…'; }
    if (Date.now() < Date.parse(data.expiresAt)) setTimeout(poll, Math.max(2, data.intervalSec ?? 3) * 1000);
  };
  setTimeout(poll, 2000);
}

export function connection(s: Snapshot) {
  const newest = s.kit?.latestVersion;
  const reachable = s.docker?.reachable;
  const notices = s.notices.map((n) => muted((n.title ? n.title + ' · ' : '') + n.reason));
  return element('div', 'stack', element('h1', '', 'Подключение'),
    card('Локальный пульт', badge('На связи', 'ok'), muted('Версия ' + s.version),
      newest && newest !== s.version && action('update.prepare', newest)),
    card('Docker', badge(reachable === true ? 'Доступен' : reachable === false ? 'Нет связи' : 'Состояние неизвестно'), action('diagnostics.run')),
    card('Учебная платформа', badge(s.policy.connected ? (s.policy.stale ? 'Данные из кеша' : 'Подключена') : 'Вход не выполнен'), s.user && muted(s.user.name),
      s.policy.reason && muted(s.policy.reason), s.policy.lastOkAt && muted('Последняя связь · ' + date(s.policy.lastOkAt)),
      s.policy.offlineGraceHours != null && muted('Допустимая работа без связи · ' + s.policy.offlineGraceHours + ' ч'),
      row(button(s.policy.connected ? 'Переподключить' : 'Подключить', login, 'primary'), action('platform.refresh'), s.policy.connected && action('platform.logout'))),
    notices.length > 0 && card('Остановки по правилам платформы', ...notices));
}

