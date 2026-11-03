import { confirm } from '@inquirer/prompts';
import { join } from 'node:path';
import type { Runtime } from '../config';
import { listKitContainers, profileState } from '../docker/kit-docker';
import { resetModule, startModule, type Progress } from '../modules/lifecycle';
import { checkAttempt, fetchAttemptProbes, putAttemptReport, startTask, type PlatformAuth } from '../platform/client';
import { supportedPrimitives } from '../platform/primitives';
import type { CheckOutcome, Session, TaskDefinition } from '../platform/types';
import { collectObservations, runActions, type ProbeSpec, type StepReport } from '../probes/run';
import { fetchScenarioLabel } from '../probes/bank-api';
import { errorText } from '../probes/errors';
import { workSize } from '../probes/work';
import type { ProbeContext } from '../probes/types';
import { readConfig, readCurrentTask, writeCurrentTask, type CurrentTask } from '../store/stores';
import { color, errorLine, line } from '../util/out';
import { askYesNo } from './idle';
import { findTask, renderCondition, renderOutcome, renderTaskRows, taskName } from './task-render';

function authOf(runtime: Runtime): PlatformAuth | null {
  const config = readConfig(runtime.dataDir);
  if (!config.token) return null;
  return { platformUrl: config.platformUrl ?? runtime.platformUrl, token: config.token, kitVersion: runtime.version };
}

function probeContext(runtime: Runtime, label: string, auth?: PlatformAuth | null, attemptId?: string): ProbeContext {
  return {
    workDir: join(runtime.kitDir, 'work'),
    hostWorkDir: join(runtime.hostDir, 'work'),
    label,
    dataDir: runtime.dataDir,
    results: {},
    saveReport:
      auth && attemptId
        ? async (report) => {
            const saved = await putAttemptReport(auth, attemptId, report);
            if (!saved.ok) throw new Error(saved.message);
          }
        : undefined,
  };
}

async function currentProbes(auth: PlatformAuth, attemptId: string): Promise<{ probes: ProbeSpec[] } | { error: string }> {
  const fetched = await fetchAttemptProbes(auth, attemptId);
  return fetched.ok ? { probes: fetched.value.probes } : { error: fetched.message };
}

function stepLine(progress: Progress, step: StepReport): void {
  if (step.ok) progress.info(`  ${color.green('✓')} ${step.name}`);
  else progress.info(`  ${color.red('✗')} ${step.name}: ${step.detail ?? 'не удалось'}`);
}

async function ensureModules(
  runtime: Runtime,
  session: Session,
  keys: string[],
  progress: Progress,
  reset: boolean,
): Promise<boolean> {
  for (const key of keys) {
    const module = session.modules.find((item) => item.key === key);
    if (!module) {
      progress.fail(`Стенд ${key} сейчас выключен на платформе`);
      return false;
    }
    if (reset && !(await resetModule(module, progress))) return false;
    const containers = await listKitContainers();
    if (profileState(containers, module.profile) === 'running') continue;
    if (!(await startModule(runtime, session, module, progress))) return false;
  }
  return true;
}

export function printTaskList(session: Session): void {
  line(color.bold('Задачи на компьютере'));
  line();
  for (const row of renderTaskRows(session.tasks, null)) line(row);
  if (session.tasks.length) {
    line();
    line(color.dim('Начать: ./stand task start <номер>. Проверить: ./stand check.'));
  }
}

function printDefinition(task: CurrentTask): void {
  line();
  line(color.bold(task.title));
  line(`Стенды: ${task.modules.map((module) => module.title).join(', ')}`);
  line();
  for (const row of renderCondition(task.promptMd)) line(row);
  line();
  if (task.input === 'bug-report') {
    line(color.dim('Баг-репорт заполните на странице задачи на платформе, затем запустите ./stand check.'));
  }
  if (task.input === 'answer-field') {
    line(color.dim('Ответ впишите на странице задачи на платформе, затем запустите ./stand check.'));
  }
  line(color.dim('Файлы кладите в папку work/. Проверить решение: ./stand check (в меню — П).'));
}

function toCurrent(labId: string, definition: TaskDefinition, seeded: boolean): CurrentTask {
  return {
    labId,
    attemptId: definition.attemptId,
    label: definition.label,
    title: definition.title,
    promptMd: definition.promptMd,
    input: definition.input,
    modules: definition.modules,
    probes: definition.probes,
    seeded,
  };
}

export async function startTaskFlow(
  runtime: Runtime,
  session: Session,
  selector: string,
  progress: Progress,
  options: { force?: boolean; ask?: (message: string) => Promise<boolean> } = {},
): Promise<boolean> {
  const task = findTask(session.tasks, selector);
  if (!task) {
    progress.fail(`Нет такой задачи: ${selector}. Список: ./stand tasks`);
    return false;
  }
  if (task.needsUpdate) {
    progress.fail(`«${task.title}»: пульт не знает проверок задачи (${task.missingPrimitives.join(', ')}). Обновите набор.`);
    return false;
  }
  const auth = authOf(runtime);
  if (!auth) {
    progress.fail('Токен не задан. Выполните: ./stand login');
    return false;
  }
  const started = await startTask(auth, task.id, await supportedPrimitives());
  if (!started.ok) {
    progress.fail(started.message);
    return false;
  }
  const definition = started.value;
  const previous = readCurrentTask(runtime.dataDir);
  let sameAttempt = !options.force && previous?.attemptId === definition.attemptId && previous.seeded;
  const bankScenario = definition.seed.some((step) => step.action === 'bank.scenario');
  const continuing = previous?.attemptId === definition.attemptId || task.attemptId === definition.attemptId;
  const context = probeContext(runtime, definition.label, auth, definition.attemptId);
  if (!(await ensureModules(runtime, session, definition.modules.map((module) => module.key), progress, false))) return false;
  if (bankScenario) {
    let active: string | null;
    try {
      active = await fetchScenarioLabel(context);
    } catch (error) {
      progress.fail(`Не удалось проверить окружение банка: ${errorText(error)}. Данные не сброшены. Обновите набор и повторите запуск.`);
      return false;
    }
    sameAttempt = !options.force && active === definition.label;
    if (!sameAttempt && (continuing || active !== null || options.force)) {
      const message = 'Подготовить задачу заново? Данные банка, включая переводы, будут сброшены; файлы в work/ сохранятся.';
      const ask = options.ask ?? (process.stdin.isTTY ? (message: string) => askYesNo(`${message} [д/Н]`, { settleMs: 300, defaultYes: false }) : null);
      if (ask ? !(await ask(message)) : !options.force) {
        progress.fail('Окружение банка не соответствует задаче. Данные сохранены. Для явного восстановления выберите задачу и выполните ./stand task restart: банк будет сброшен, work/ сохранится.');
        return false;
      }
      progress.info('Повторная подготовка: данные банка будут сброшены; файлы в work/ сохранятся.');
    }
  }
  if (!sameAttempt) {
    progress.info('Готовлю стенды к задаче');
    let failure: string | null;
    try {
      const seed = bankScenario ? definition.seed.filter((step) =>
        step.action !== 'file.write' || typeof step.params.path !== 'string' || workSize(context, step.params.path) === null,
      ) : definition.seed;
      failure = await runActions(seed, context, (step) => stepLine(progress, step));
    } catch (error) {
      failure = errorText(error);
    }
    if (failure) {
      progress.fail(`Подготовка не удалась: ${failure}`);
      return false;
    }
  }
  const current = toCurrent(task.id, definition, true);
  writeCurrentTask(runtime.dataDir, current);
  if (options.force) {
    const bank = definition.modules.some((module) => module.key === 'kit-bank');
    progress.info(`Задача ${taskName(task)} подготовлена заново: ${bank ? 'банк сброшен, ' : ''}сценарий применён. Файлы в work/ не тронуты.`);
    return true;
  }
  printDefinition(current);
  return true;
}

export async function restartTaskFlow(runtime: Runtime, session: Session, progress: Progress): Promise<boolean> {
  const current = readCurrentTask(runtime.dataDir);
  if (!current) {
    progress.fail('Текущей задачи нет. Выберите: ./stand tasks, затем ./stand task start <номер>');
    return false;
  }
  return startTaskFlow(runtime, session, current.labId, progress, { force: true });
}

export function showCurrentTask(runtime: Runtime): number {
  const current = readCurrentTask(runtime.dataDir);
  if (!current) {
    errorLine('Текущей задачи нет. Выберите: ./stand tasks, затем ./stand task start <номер>');
    return 1;
  }
  printDefinition(current);
  return 0;
}

export async function checkFlow(runtime: Runtime, progress: Progress): Promise<CheckOutcome | null> {
  const current = readCurrentTask(runtime.dataDir);
  if (!current) {
    progress.fail('Текущей задачи нет. Выберите: ./stand tasks, затем ./stand task start <номер>');
    return null;
  }
  const auth = authOf(runtime);
  if (!auth) {
    progress.fail('Токен не задан. Выполните: ./stand login');
    return null;
  }
  if (current.modules.some((module) => module.key === 'kit-bank')) {
    try {
      if (await fetchScenarioLabel(probeContext(runtime, current.label)) !== current.label) {
        progress.fail('Окружение банка не соответствует текущей задаче. Проверка не отправлена. Запустите задачу снова, чтобы проверить окружение.');
        return null;
      }
    } catch (error) {
      progress.fail(`Не удалось проверить окружение банка: ${errorText(error)}. Проверка не отправлена.`);
      return null;
    }
  }
  const fresh = await currentProbes(auth, current.attemptId);
  if ('error' in fresh) {
    progress.fail(fresh.error);
    return null;
  }
  progress.info(`Собираю факты: ${current.title}`);
  const observations = await collectObservations(fresh.probes, probeContext(runtime, current.label), (step) =>
    stepLine(progress, step),
  );
  const checked = await checkAttempt(auth, current.attemptId, observations);
  if (!checked.ok) {
    progress.fail(checked.message);
    return null;
  }
  line();
  for (const row of renderOutcome(current.title, checked.value)) line(row);
  if (checked.value.status === 'PASSED') writeCurrentTask(runtime.dataDir, null);
  return checked.value;
}

type VerifyOptions = { yes: boolean; reset: boolean };

async function confirmReset(modules: string[], options: VerifyOptions): Promise<boolean> {
  if (!options.reset || options.yes) return true;
  if (!process.stdin.isTTY) {
    errorLine('Проверка эталоном стирает данные стендов. Без терминала добавьте --yes.');
    return false;
  }
  return confirm({ message: `Удалить данные стендов (${modules.join(', ')}) и проверить эталоном?`, default: false });
}

async function runCheck(
  auth: PlatformAuth,
  definition: TaskDefinition,
  runtime: Runtime,
  progress: Progress,
): Promise<CheckOutcome | null> {
  const fresh = await currentProbes(auth, definition.attemptId);
  if ('error' in fresh) {
    progress.fail(fresh.error);
    return null;
  }
  const observations = await collectObservations(fresh.probes, probeContext(runtime, definition.label), (step) =>
    stepLine(progress, step),
  );
  const checked = await checkAttempt(auth, definition.attemptId, observations);
  if (!checked.ok) {
    progress.fail(checked.message);
    return null;
  }
  return checked.value;
}

export async function verifyFlow(
  runtime: Runtime,
  session: Session,
  labId: string,
  options: VerifyOptions,
  progress: Progress,
): Promise<boolean> {
  const auth = authOf(runtime);
  if (!auth) {
    progress.fail('Токен не задан. Выполните: ./stand login');
    return false;
  }
  const started = await startTask(auth, labId, await supportedPrimitives());
  if (!started.ok) {
    progress.fail(started.message);
    return false;
  }
  const definition = started.value;
  if (!definition.reference) {
    progress.fail('Эталон видят только администраторы: войдите токеном администратора.');
    return false;
  }
  const keys = definition.modules.map((module) => module.key);
  if (!(await confirmReset(keys, options))) return false;
  if (!(await ensureModules(runtime, session, keys, progress, options.reset))) return false;
  const context = probeContext(runtime, definition.label, auth, definition.attemptId);

  progress.info('Подготовка задачи');
  const seedFailure = await runActions(definition.seed, context, (step) => stepLine(progress, step));
  if (seedFailure) {
    progress.fail(`Подготовка не удалась: ${seedFailure}`);
    return false;
  }
  progress.info('Проверка пустого решения');
  const empty = await runCheck(auth, definition, runtime, progress);
  if (!empty) return false;
  progress.info('Применяю эталон');
  const referenceFailure = await runActions(definition.reference, context, (step) => stepLine(progress, step));
  if (referenceFailure) {
    progress.fail(`Эталон не применился: ${referenceFailure}`);
    return false;
  }
  progress.info('Проверка эталона');
  const reference = await runCheck(auth, definition, runtime, progress);
  if (!reference) return false;

  line();
  for (const row of renderOutcome(definition.title, reference)) line(row);
  line();
  const emptyRejected = empty.status === 'FAILED';
  const referencePasses = reference.status === 'PASSED';
  const emptyText = `Пустой не проходит: ${emptyRejected ? 'да' : 'НЕТ'} (${empty.result.summary.passed} из ${empty.result.summary.total} пунктов уже выполнены без решения)`;
  const referenceText = `Эталон проходит: ${referencePasses ? 'да' : 'НЕТ'} (${reference.result.summary.passed} из ${reference.result.summary.total})`;
  if (emptyRejected) progress.ok(emptyText);
  else progress.fail(empty.result.unavailable ? 'Пустое решение: проверка не состоялась' : emptyText);
  if (referencePasses) progress.ok(referenceText);
  else progress.fail(referenceText);
  return emptyRejected && referencePasses;
}
