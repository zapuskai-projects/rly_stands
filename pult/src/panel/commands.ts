import type { Runtime } from '../config';
import { PanelError } from './errors';
import { line } from '../util/out';
import { internalCall } from './gateway';
import { servePanel } from './server';

export async function panelCommand(runtime: Runtime, args: string[]): Promise<void> {
  if (args[0] === 'serve' && args.length === 1) { await servePanel(runtime); return; }
  if (args[0] === 'bootstrap' && args.length === 1) {
    const result = await internalCall(runtime, '/internal/bootstrap', {}) as { nonce: string };
    process.stdout.write(`${result.nonce}\n`); return;
  }
  if (args[0] === 'meta' && args.length === 1) { process.stdout.write(`${JSON.stringify(await internalCall(runtime, '/internal/meta'))}\n`); return; }
  if (args[0] === 'bridge') {
    const [, verb, pid, arg, version, reason] = args;
    const payload = verb === 'reclaim' ? { verb, pid, previous: arg } : { verb, pid, id: arg, version, reason };
    let retries = 0;
    for (;;) {
      try {
        const result = await internalCall(runtime, '/internal/bridge', payload) as { value: string };
        line(result.value);
        break;
      } catch (error) {
        if (verb !== 'complete' || !(error instanceof PanelError) || error.code !== 'OPERATION_CONFLICT' || retries++ >= 30) throw error;
        await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
    return;
  }
  line('Команды панели: panel serve | panel bootstrap | panel meta');
  process.exitCode = 1;
}
