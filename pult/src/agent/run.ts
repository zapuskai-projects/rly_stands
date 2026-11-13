import type { Runtime } from '../config';
import { formatClock } from '../cli/format';
import { line } from '../util/out';
import { dispatchAction } from '../actions/dispatcher';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(text: string): void {
  line(`[agent ${formatClock()}] ${text}`);
}

export async function agentTick(runtime: Runtime): Promise<void> {
  await dispatchAction({ runtime, progress: { info: log, ok: log, fail: log } }, { action: 'policy.enforce' });
}

export async function runAgent(runtime: Runtime): Promise<never> {
  log(`запущен, опрос платформы каждые ${runtime.agentIntervalSec} с`);
  for (;;) {
    try {
      await agentTick(runtime);
    } catch (error) {
      log(`сбой цикла: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(runtime.agentIntervalSec * 1000);
  }
}
