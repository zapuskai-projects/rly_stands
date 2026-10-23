import type { Runtime } from '../config';
import { listKitContainers, profileState } from '../docker/kit-docker';
import { startModule, stopModule, versionGate, type Progress } from '../modules/lifecycle';
import { preflight } from '../modules/preflight';
import type { Session, SessionModule, SessionTask } from '../platform/types';
import { readCurrentTask } from '../store/stores';
import { requestOpen } from '../util/open-url';
import { color, line } from '../util/out';
import { startTaskFlow } from './tasks';

/** Модули окружения учебных проектов человека в порядке сессии. */
export function projectModules(session: Session): SessionModule[] {
  const keys = new Set((session.projects ?? []).flatMap((project) => project.modules));
  return session.modules.filter((module) => keys.has(module.key) || Boolean(module.project));
}

/** Главный экран проекта — первый модуль окружения с адресом (у банка — интернет-банк). */
export function mainModule(modules: SessionModule[]): SessionModule | null {
  return modules.find((module) => module.uis.length > 0) ?? null;
}

/** Текущий открытый тикет: на нём человек работает сейчас. */
export function currentTicket(session: Session): SessionTask | null {
  return session.tasks.find((task) => task.project?.current && task.project.state === 'OPEN') ?? null;
}

export function ticketUrl(session: Session, task: SessionTask): string | null {
  return session.webUrl ? `${session.webUrl.replace(/\/+$/, '')}/student/labs/${encodeURIComponent(task.id)}` : null;
}

/** Начатый тикет не готовится заново: подготовка стёрла бы то, что человек уже сделал. */
export function ticketNeedsStart(task: SessionTask, currentLabId: string | null): boolean {
  return task.status !== 'PASSED' && currentLabId !== task.id;
}

/** Банк с зависимостями и модули текущего тикета: всё окружение проекта в память не помещается. */
export function startupModules(session: Session): SessionModule[] {
  const environment = projectModules(session);
  const base = mainModule(environment);
  const wanted = new Set<string>(base ? [base.key] : []);
  for (const item of currentTicket(session)?.modules ?? []) {
    if (environment.some((module) => module.key === item.key)) wanted.add(item.key);
  }
  if (!wanted.size) return environment;
  const queue = [...wanted];
  while (queue.length) {
    const module = session.modules.find((item) => item.key === queue.shift());
    for (const key of module?.requires ?? []) {
      if (wanted.has(key)) continue;
      wanted.add(key);
      queue.push(key);
    }
  }
  return session.modules.filter((module) => wanted.has(module.key));
}

/** Модули окружения, которые текущему тикету не нужны: остались от прошлого тикета и держат память. */
export function idleModules(session: Session): SessionModule[] {
  const wanted = new Set(startupModules(session).map((module) => module.key));
  return projectModules(session).filter((module) => !wanted.has(module.key));
}

export type StartOutcome = { code: number; hasProject: boolean };

export async function startProjectFlow(runtime: Runtime, session: Session, progress: Progress): Promise<StartOutcome> {
  if (!projectModules(session).length) return { code: 0, hasProject: false };
  const modules = startupModules(session);
  const titles = (session.projects ?? []).map((project) => `«${project.title}»`).join(', ');
  const gate = versionGate(runtime, session);
  if (gate) {
    progress.fail(gate);
    return { code: 1, hasProject: true };
  }

  for (const module of idleModules(session)) {
    if (profileState(await listKitContainers(), module.profile) === 'stopped') continue;
    progress.info(`${module.title} текущему тикету не нужен — останавливаю, данные сохраняются`);
    if (!(await stopModule(module, progress))) return { code: 1, hasProject: true };
  }

  progress.info(`Проверяю компьютер перед запуском проекта ${titles}`);
  const problems = await preflight(runtime, modules);
  if (problems.length) {
    for (const problem of problems) progress.fail(problem);
    return { code: 1, hasProject: true };
  }

  const startedNow: SessionModule[] = [];
  for (const module of modules) {
    if (profileState(await listKitContainers(), module.profile) === 'running') continue;
    if (!(await startModule(runtime, session, module, progress))) return { code: 1, hasProject: true };
    startedNow.push(module);
  }

  const ticket = currentTicket(session);
  let ticketStarted = false;
  if (ticket && ticketNeedsStart(ticket, readCurrentTask(runtime.dataDir)?.labId ?? null)) {
    if (!(await startTaskFlow(runtime, session, ticket.id, progress))) return { code: 1, hasProject: true };
    ticketStarted = true;
  }

  line();
  line(color.bold(`Проект ${titles} работает`));
  for (const module of modules) for (const ui of module.uis) line(`  ${ui.title}: ${ui.url}`);
  const url = ticket ? ticketUrl(session, ticket) : null;
  if (ticket) {
    const name = [ticket.project?.code, ticket.title].filter(Boolean).join(' ');
    line(`  Тикет ${name}${url ? `: ${url}` : ''}`);
  }
  line(color.dim(ticket ? 'Проверить решение: ./stand check. Условие ещё раз: ./stand task.' : 'Все тикеты роли сданы.'));

  const main = mainModule(modules);
  if (main && startedNow.includes(main)) requestOpen(runtime, main.uis[0]!.url);
  if (ticketStarted && url) requestOpen(runtime, url);
  return { code: 0, hasProject: true };
}
