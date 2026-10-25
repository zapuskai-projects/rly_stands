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

export function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    write(`${question} `);
    const handler = (_chunk: string, key: AnswerKey) => {
      const answer = answerOf(key ?? {});
      if (answer === null) return;
      process.stdin.off('keypress', handler);
      process.stdin.setRawMode(wasRaw);
      write(`${answer ? 'Д' : 'н'}\n`);
      resolve(answer);
    };
    process.stdin.on('keypress', handler);
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
