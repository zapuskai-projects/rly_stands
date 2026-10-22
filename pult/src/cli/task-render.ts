import type { CheckOutcome, SessionTask, TaskStatus } from '../platform/types';
import { color, padRight } from '../util/out';

const STATUS_WORD: Record<TaskStatus, string> = {
  NOT_STARTED: 'не начата',
  STARTED: 'в работе',
  FAILED: 'не зачтена',
  PASSED: 'зачтена',
};

export function taskStatusWord(task: SessionTask): string {
  return task.needsUpdate ? 'обновите набор' : STATUS_WORD[task.status];
}

function statusColor(task: SessionTask, text: string): string {
  if (task.needsUpdate) return color.yellow(text);
  if (task.status === 'PASSED') return color.green(text);
  if (task.status === 'FAILED') return color.red(text);
  return task.status === 'NOT_STARTED' ? color.dim(text) : text;
}

export function renderTaskRows(tasks: SessionTask[], selected: number | null): string[] {
  if (!tasks.length) return ['    Для вас пока нет задач на компьютере.'];
  const numberWidth = String(tasks.length).length;
  const titleWidth = Math.min(48, Math.max(8, ...tasks.map((task) => task.title.length))) + 2;
  const modulesWidth = Math.max(8, ...tasks.map((task) => task.modules.map((item) => item.title).join(', ').length)) + 2;
  return tasks.map((task, index) => {
    const cursor = selected === index ? color.bold('▸') : ' ';
    const title = task.title.length > titleWidth - 2 ? `${task.title.slice(0, titleWidth - 3)}…` : task.title;
    const modules = task.modules.map((item) => item.title).join(', ');
    return ` ${cursor} ${padRight(String(index + 1), numberWidth + 1)}${padRight(title, titleWidth)}${padRight(modules, modulesWidth)}${statusColor(task, taskStatusWord(task))}`.trimEnd();
  });
}

export function findTask(tasks: SessionTask[], selector: string): SessionTask | undefined {
  const wanted = selector.trim().toLowerCase();
  if (/^\d+$/.test(wanted)) return tasks[Number(wanted) - 1];
  const exact = tasks.find((task) => task.id.toLowerCase() === wanted || task.title.toLowerCase() === wanted);
  if (exact) return exact;
  const partial = tasks.filter((task) => task.id.toLowerCase().startsWith(wanted) || task.title.toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : undefined;
}

export function renderCondition(markdown: string): string[] {
  return markdown
    .trim()
    .split('\n')
    .map((row) => row.replace(/\*\*(.+?)\*\*/g, (_, text: string) => color.bold(text)));
}

export function renderOutcome(title: string, label: string, outcome: CheckOutcome): string[] {
  const { result } = outcome;
  const lines = [color.bold(`${title} · метка ${label}`)];
  for (const item of result.assertionResults) {
    if (item.unavailable) lines.push(color.yellow(`? ${item.title}`));
    else if (item.passed) lines.push(color.green(`✓ ${item.title}`));
    else {
      lines.push(color.red(`✗ ${item.title}`));
      if (item.hint) lines.push(color.dim(`  Подсказка: ${item.hint}`));
    }
  }
  lines.push('');
  const { passed, total } = result.summary;
  if (result.unavailable) {
    lines.push(color.yellow(result.message));
    if (result.detail) lines.push(color.dim(`  ${result.detail}`));
    lines.push(
      result.reviewUnavailable
        ? 'Решение собрано, не ответила проверка на платформе. Запустите ./stand check ещё раз.'
        : 'Проверьте, что стенды запущены (./stand status), и запустите проверку снова.',
    );
  } else if (result.passed) {
    lines.push(color.green(`Итог: зачтено, ${passed} из ${total}.`));
  } else {
    lines.push(`Итог: не зачтено, ${passed} из ${total}. Исправьте и запустите проверку снова.`);
  }
  return lines;
}
