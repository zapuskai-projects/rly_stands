export type Key = { name?: string; ctrl?: boolean; sequence?: string };

export type KeyAction = 'interrupt' | 'back' | 'tasks' | 'check' | 'update' | 'stopAll' | 'restart' | 'up' | 'down' | 'enter';

const BACK_LETTERS = new Set(['в', 'В']);
const TASKS_LETTERS = new Set(['з', 'З']);
const CHECK_LETTERS = new Set(['п', 'П']);
const STOP_ALL_LETTERS = new Set(['о', 'О']);
const RESTART_LETTERS = new Set(['р', 'Р']);
const UPDATE_LETTERS = new Set(['у', 'У']);

export function keyAction(key: Key, updatePending = false): KeyAction | null {
  const name = key.name ?? '';
  const sequence = key.sequence ?? '';
  if (key.ctrl) return name === 'c' ? 'interrupt' : null;
  if (name === 'escape' || name === 'q' || BACK_LETTERS.has(sequence)) return 'back';
  if (name === 't' || TASKS_LETTERS.has(sequence)) return 'tasks';
  if (name === 'p' || CHECK_LETTERS.has(sequence)) return 'check';
  if (updatePending && (name === 'u' || UPDATE_LETTERS.has(sequence))) return 'update';
  if (name === 's' || STOP_ALL_LETTERS.has(sequence)) return 'stopAll';
  if (name === 'r' || RESTART_LETTERS.has(sequence)) return 'restart';
  if (name === 'up') return 'up';
  if (name === 'down') return 'down';
  if (name === 'return') return 'enter';
  return null;
}
