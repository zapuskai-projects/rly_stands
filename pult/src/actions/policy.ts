import type { Runtime } from '../config';
import { versionGate } from '../modules/lifecycle';
import { requiredModules } from '../modules/requires';
import type { Session, SessionModule } from '../platform/types';
import { readCurrentTask, type CurrentTask } from '../store/stores';
import { findTask } from '../cli/task-render';
import { startupModules } from './project';
import type { ActionPlan, ActionRequest } from './types';

const UNGUARDED = new Set(['diagnostics.run', 'platform.refresh', 'platform.logout', 'policy.enforce', 'modules.stopAll', 'module.stop']);

export function actionModules(request: ActionRequest, session: Session, current?: CurrentTask | null): SessionModule[] {
  if ('moduleKey' in request) return session.modules.filter((module) => module.key === request.moduleKey);
  if ('selector' in request) {
    const keys = new Set(findTask(session.tasks, request.selector)?.modules.map((module) => module.key) ?? []);
    return session.modules.filter((module) => keys.has(module.key));
  }
  if (request.action === 'project.ensureStarted') return startupModules(session);
  if (request.action === 'task.check' || request.action === 'task.resume') {
    return session.modules.filter((module) => current?.modules.some((item) => item.key === module.key));
  }
  return request.action === 'modules.stopAll' ? session.modules : [];
}

export function planAction(runtime: Runtime, session: Session | undefined, request: ActionRequest, stale = false): ActionPlan {
  const plan: ActionPlan = { allowed: true, targets: [], consequences: [], confirmationRequired: false };
  const deny = (code: string, reason: string): ActionPlan => ({ ...plan, allowed: false, code, reason });
  if (request.action === 'platform.logout') {
    plan.confirmationRequired = true;
    plan.consequences = ['Токен платформы будет удалён. Запущенные стенды затем могут быть остановлены политикой доступа; данные сохранятся.'];
  }
  if (request.action === 'modules.stopAll') plan.consequences = ['Все локальные учебные стенды будут остановлены; данные сохранятся. Панель продолжит работать.'];
  if (!session) return UNGUARDED.has(request.action) && !request.action.startsWith('module.') ? plan : deny('SESSION_REQUIRED', 'Нужна действующая сессия платформы');
  const activeTaskAction = request.action === 'task.check' || request.action === 'task.resume';
  const current = activeTaskAction ? readCurrentTask(runtime.dataDir) : null;
  const modules = actionModules(request, session, current);
  plan.targets = modules.map((module) => module.key);
  if ('moduleKey' in request && !modules.length) return deny('MODULE_UNAVAILABLE', 'Стенд отсутствует в назначениях');
  if ('selector' in request && !findTask(session.tasks, request.selector)) return deny('TASK_UNAVAILABLE', 'Задача отсутствует в назначениях');
  if (request.action === 'module.stop' || request.action === 'module.restart') {
    const dependent = session.modules.filter((item) => item.requires?.includes(modules[0]?.key ?? ''));
    plan.consequences = [`Работа стенда будет прервана; данные сохранятся.${dependent.length ? ` Затронуты: ${dependent.map((item) => item.title).join(', ')}.` : ''}`];
  }
  if (UNGUARDED.has(request.action)) return plan;
  const gate = versionGate(runtime, session);
  if (gate && request.action !== 'update.prepare') return deny('VERSION_REQUIRED', gate);
  if (stale && (request.action.startsWith('task.') || request.action.startsWith('update.') || request.action === 'project.ensureStarted')) {
    return deny('PLATFORM_REQUIRED', 'Для подготовки и проверки задачи или обновления нужна связь с платформой');
  }
  if (activeTaskAction) {
    if (!current) return deny('TASK_UNAVAILABLE', 'Текущей задачи нет. Выберите задание и подготовьте его.');
    if (request.labId && current.labId !== request.labId) return deny('TASK_CHANGED', 'Активное задание изменилось. Обновите список.');
    if (!session.tasks.some((task) => task.id === current.labId)) return deny('TASK_UNAVAILABLE', 'Текущая задача больше не назначена');
    const missing = current.modules.find((item) => !modules.some((module) => module.key === item.key));
    if (missing) return deny('MODULE_UNAVAILABLE', `Стенд «${missing.title}» отсутствует в назначениях`);
  }
  const queue = [...modules];
  for (let index = 0; index < queue.length; index += 1) {
    const module = queue[index]!;
    if (!module.allowed) return deny('MODULE_UNAVAILABLE', module.reason ?? `${module.title}: недоступен`);
    const dependencies = requiredModules(session, module);
    if (dependencies.missing.length) return deny('DEPENDENCY_UNAVAILABLE', `Недоступны зависимости: ${dependencies.missing.join(', ')}`);
    for (const dependency of dependencies.modules) {
      if (plan.targets.includes(dependency.key)) continue;
      plan.targets.push(dependency.key);
      queue.push(dependency);
    }
  }
  if (request.action === 'update.prepare' && ![session.kit.latestVersion, session.kit.minVersion].includes(request.version)) return deny('VERSION_UNAVAILABLE', 'Версия обновления не подтверждена платформой');
  if (request.action === 'module.reset') {
    const module = modules[0]!;
    if (session.modules.some((item) => item.profile === 'bank' && item.requires?.includes(module.key))) {
      return deny('SHARED_STORAGE', 'Этот стенд хранит общие данные банка. Используйте отдельный сброс банка.');
    }
    plan.confirmationRequired = true;
    plan.consequences = [module.profile === 'linux' ? 'Будут удалены контейнер Linux и все файлы внутри Linux.' : `Будут удалены контейнеры и данные стенда «${module.title}».`, 'Файлы work, ответы и зачёт сохранятся.'];
  } else if (request.action === 'task.restart') {
    plan.confirmationRequired = true;
    plan.consequences = ['Сценарий задачи будет применён заново; данные банка, включая переводы, будут удалены.', 'Файлы work, ответы и зачёт сохранятся.'];

  }
  return plan;
}
