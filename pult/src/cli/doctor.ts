import type { Runtime } from '../config';
import { dispatchAction } from '../actions/dispatcher';
import { color, line } from '../util/out';
import { consoleProgress } from './progress';
export { comparePrimitives } from '../actions/doctor';

export async function runDoctor(runtime: Runtime): Promise<number> {
  const result = await dispatchAction({ runtime, progress: consoleProgress, diagnostic: (verdict, text) => {
    const mark = verdict === 'ok' ? color.green('✓') : verdict === 'warn' ? color.yellow('!') : color.red('✗');
    line(`  ${mark} ${text}`);
  } }, { action: 'diagnostics.run' });
  return result.ok ? 0 : 1;
}
