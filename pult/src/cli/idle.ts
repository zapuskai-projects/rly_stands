import { emitKeypressEvents } from 'node:readline';
import { profileState, type KitContainer } from '../docker/kit-docker';
import type { Session, SessionModule } from '../platform/types';
import { write } from '../util/out';
import { idleModules } from './start';

export type AnswerKey = { name?: string; sequence?: string; ctrl?: boolean };

/** Модули, которые держат память и текущей задаче не нужны; запускаемые сейчас модули и их зависимости не трогаем. */
export function idleToStop(session: Session, starting: SessionModule[], containers: KitContainer[]): SessionModule[] {
  const keep = new Set(starting.map((module) => module.key));
  const queue = [...keep];
  while (queue.length) {
    const module = session.modules.find((item) => item.key === queue.shift());
    for (const key of module?.requires ?? []) {
      if (keep.has(key)) continue;
      keep.add(key);
      queue.push(key);
    }
  }
  return idleModules(session).filter((module) => !keep.has(module.key) && profileState(containers, module.profile) !== 'stopped');
}

export function idleQuestion(modules: SessionModule[]): string {
  return `Остановить модули, которые не нужны текущей задаче: ${modules.map((module) => module.title).join(', ')}? [Д/н]`;
}

/** Д, y, Enter — да; н, n, Esc, Ctrl+C — нет; остальные клавиши ответом не считаются. */
export function answerOf(key: AnswerKey): boolean | null {
  if (key.ctrl && key.name === 'c') return false;
  const letter = (key.sequence ?? '').toLowerCase();
  if (key.name === 'return' || key.name === 'enter' || letter === 'д' || letter === 'y') return true;
  if (key.name === 'escape' || letter === 'н' || letter === 'n') return false;
  return null;
}

export type AskInput = {
  isRaw?: boolean;
  on: (event: 'keypress', handler: (chunk: string, key: AnswerKey) => void) => unknown;
  off: (event: 'keypress', handler: (chunk: string, key: AnswerKey) => void) => unknown;
  setRawMode: (mode: boolean) => unknown;
  resume: () => unknown;
};

export type AskOptions = {
  /** Первые мгновения клавиши не считаются ответом: случайный Enter при загрузке не должен стать «да». */
  settleMs?: number;
  /** Ctrl+C завершает пульт, а не считается ответом «нет». */
  onInterrupt?: () => void;
  input?: AskInput;
  out?: (text: string) => void;
  now?: () => number;
};

export function exitPult(): void {
  write('\x1b[?25h\n');
  process.exit(130);
}

export function askYesNo(question: string, options: AskOptions = {}): Promise<boolean> {
  const input = options.input ?? (process.stdin as unknown as AskInput);
  const out = options.out ?? write;
  const now = options.now ?? Date.now;
  return new Promise((resolve) => {
    if (!options.input) emitKeypressEvents(process.stdin);
    const wasRaw = input.isRaw ?? false;
    input.setRawMode(true);
    input.resume();
    out(`${question} `);
    const askedAt = now();
    const handler = (_chunk: string, key: AnswerKey) => {
      if (now() - askedAt < (options.settleMs ?? 0)) return;
      if (options.onInterrupt && key?.ctrl && key.name === 'c') {
        input.off('keypress', handler);
        input.setRawMode(wasRaw);
        options.onInterrupt();
        return;
      }
      const answer = answerOf(key ?? {});
      if (answer === null) return;
      input.off('keypress', handler);
      input.setRawMode(wasRaw);
      out(`${answer ? 'Д' : 'н'}\n`);
      resolve(answer);
    };
    input.on('keypress', handler);
  });
}

export type IdleOffer = {
  session: Session;
  starting: SessionModule[];
  containers: KitContainer[];
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  stop: (module: SessionModule) => Promise<boolean>;
};

/** Ручной запуск модуля: спрашиваем про лишние, остановка не стирает данные. Без терминала не спрашиваем и не останавливаем. */
export async function offerStopIdle(offer: IdleOffer): Promise<{ asked: boolean; stopped: string[] }> {
  if (!offer.interactive) return { asked: false, stopped: [] };
  const idle = idleToStop(offer.session, offer.starting, offer.containers);
  if (!idle.length) return { asked: false, stopped: [] };
  if (!(await offer.ask(idleQuestion(idle)))) return { asked: true, stopped: [] };
  const stopped: string[] = [];
  for (const module of idle) if (await offer.stop(module)) stopped.push(module.key);
  return { asked: true, stopped };
}

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);
