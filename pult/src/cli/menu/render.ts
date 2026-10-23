import type { ModuleRow, RowState } from '../../modules/view';
import type { SessionTask } from '../../platform/types';
import { color, padRight } from '../../util/out';
import { renderTaskRows } from '../task-render';

export type MenuMode = 'modules' | 'tasks';

export type MenuView = {
  mode?: MenuMode;
  tasks?: SessionTask[];
  currentTask?: string | null;
  version: string;
  userName: string;
  tokenUntil: string;
  rows: ModuleRow[];
  selected: number;
  reminder: string | null;
  notices: string[];
  message: string | null;
  stale: boolean;
};

const STATE_WORD: Record<RowState, string> = {
  running: 'работает',
  partial: 'не полностью',
  stopped: 'остановлен',
  unavailable: 'недоступен',
};

const STATE_MARK: Record<RowState, (text: string) => string> = {
  running: () => color.green('●'),
  partial: () => color.yellow('◐'),
  stopped: () => color.dim('○'),
  unavailable: () => color.red('✕'),
};

export function renderRows(rows: ModuleRow[], selected: number | null): string[] {
  const titleWidth = Math.max(6, ...rows.map((row) => row.title.length)) + 2;
  const stateWidth = Math.max(...Object.values(STATE_WORD).map((word) => word.length)) + 2;
  const out = [`    ${padRight('Стенд', titleWidth + 2)}Состояние`];
  rows.forEach((row, index) => {
    const cursor = selected === index ? color.bold('▸') : ' ';
    const state = padRight(STATE_WORD[row.state], stateWidth);
    const note = row.note ? (row.state === 'unavailable' ? color.dim(row.note) : row.note) : '';
    out.push(
      ` ${cursor} ${STATE_MARK[row.state](row.state)} ${padRight(row.title, titleWidth)}${state}${note}`.trimEnd(),
    );
  });
  return out;
}

export function renderMenu(view: MenuView): string[] {
  const lines = [
    ` ${color.bold('Запускай · стенды')}                      пульт ${view.version}`,
    ` ${view.userName} · токен действует до ${view.tokenUntil}${view.stale ? ' · платформа недоступна' : ''}`,
  ];
  if (view.reminder) lines.push(` ${color.yellow(view.reminder)}`);
  for (const notice of view.notices) lines.push(` ${color.yellow(`! ${notice}`)}`);
  if (view.currentTask) lines.push(` Текущая задача: ${view.currentTask}`);
  if (view.mode === 'tasks') {
    lines.push('', ` ${color.bold('Задачи')}`, '', ...renderTaskRows(view.tasks ?? [], view.selected), '');
    if (view.message) lines.push(` ${view.message}`, '');
    lines.push(` ${color.dim('↑↓ выбрать · Enter начать задачу · П проверить · Esc назад')}`);
    return lines;
  }
  lines.push('', ...renderRows(view.rows, view.selected), '');
  if (view.message) lines.push(` ${view.message}`, '');
  lines.push(` ${color.dim('↑↓ выбрать · Enter запустить/остановить · Р перезапустить · О остановить все · З задачи · П проверить · В выйти')}`);
  return lines;
}
