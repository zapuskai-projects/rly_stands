import type { Runtime } from '../config';
import type { Progress } from '../modules/lifecycle';
import type { Session } from '../platform/types';
import { readCurrentTask, type CurrentTask } from '../store/stores';
import { color, errorLine, line } from '../util/out';
import { dispatchAction } from '../actions/dispatcher';
import { askYesNo, isInteractive } from './idle';
import { renderCondition, renderOutcome, renderTaskRows } from './task-render';

export function printTaskList(session: Session): void {
  line(color.bold('Задачи на компьютере'));
  line();
  for (const row of renderTaskRows(session.tasks, null)) line(row);
  if (session.tasks.length) {
    line();
    line(color.dim('Начать: ./stand task start <номер>. Проверить: ./stand check.'));
  }
}

export function printDefinition(task: CurrentTask): void {
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


export const taskConfirmation = (message: string): Promise<boolean> => isInteractive()
  ? askYesNo(`${message} [д/Н]`, { settleMs: 300, defaultYes: false })
  : Promise.resolve(false);

export async function startTaskFlow(runtime: Runtime, session: Session, selector: string, progress: Progress,
  options: { force?: boolean; ask?: (message: string) => Promise<boolean>; stale?: boolean } = {}): Promise<boolean> {
  const result = await dispatchAction({ runtime, session, stale: options.stale, progress, ask: options.ask ?? taskConfirmation, showTask: printDefinition },
    { action: options.force ? 'task.restart' : 'task.start', selector });
  return result.ok;
}

export async function restartTaskFlow(runtime: Runtime, session: Session, progress: Progress, options: { yes?: boolean; ask?: (message: string) => Promise<boolean>; stale?: boolean } = {}): Promise<boolean> {
  const current = readCurrentTask(runtime.dataDir);
  if (!current) { progress.fail('Текущей задачи нет. Выберите: ./stand tasks, затем ./stand task start <номер>'); return false; }
  return startTaskFlow(runtime, session, current.labId, progress, { force: true, stale: options.stale, ask: options.yes ? async () => true : options.ask });
}

export function showCurrentTask(runtime: Runtime): number {
  const current = readCurrentTask(runtime.dataDir);
  if (!current) { errorLine('Текущей задачи нет. Выберите: ./stand tasks, затем ./stand task start <номер>'); return 1; }
  printDefinition(current);
  return 0;
}

export async function checkFlow(runtime: Runtime, progress: Progress, session?: Session, stale = false) {
  const result = await dispatchAction({ runtime, session, stale, progress }, { action: 'task.check' });
  const outcome = result.check ?? null;
  if (outcome) { line(); for (const row of renderOutcome('Проверка задачи', outcome)) line(row); }
  return outcome;
}

export async function verifyFlow(runtime: Runtime, session: Session, labId: string,
  options: { yes: boolean; reset: boolean }, progress: Progress): Promise<boolean> {
  return (await dispatchAction({ runtime, session, progress, ask: taskConfirmation }, { action: 'task.verify', selector: labId, ...options })).ok;
}
