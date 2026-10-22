import type { Progress } from '../modules/lifecycle';
import { color, line } from '../util/out';

export const consoleProgress: Progress = {
  info: (text) => line(text),
  ok: (text) => line(color.green(`✓ ${text.trim()}`)),
  fail: (text) => line(color.red(`✗ ${text.trim()}`)),
};

export function collectingProgress(): { progress: Progress; summary: () => string | null } {
  let last: string | null = null;
  const progress: Progress = {
    info: (text) => line(text),
    ok: (text) => {
      line(color.green(`✓ ${text.trim()}`));
      last = color.green(text.trim());
    },
    fail: (text) => {
      line(color.red(`✗ ${text.trim()}`));
      last = color.red(text.trim());
    },
  };
  return { progress, summary: () => last };
}
