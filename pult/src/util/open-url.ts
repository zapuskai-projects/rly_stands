import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Runtime } from '../config';

/**
 * Пульт в контейнере не может открыть браузер сам: он пишет адрес в .stand/open в папке набора,
 * а скрипт ./stand на компьютере открывает его. Папку создаёт скрипт — без неё никто не откроет.
 */
export function requestOpen(runtime: Runtime, url: string): boolean {
  if (!/^https?:\/\/\S+$/.test(url)) return false;
  const dir = join(runtime.kitDir, '.stand');
  if (process.env.STAND_NO_BROWSER === '1' || process.env.STAND_OPENER !== '1' || !existsSync(dir)) return false;
  try {
    appendFileSync(join(dir, 'open'), `${url}\n`);
    return true;
  } catch {
    return false;
  }
}
