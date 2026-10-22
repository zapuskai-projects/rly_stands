import type { Runtime } from '../config';
import { listKitContainers, runningProfiles, stopProfile } from '../docker/kit-docker';
import { fetchSession } from '../platform/client';
import { formatClock } from '../cli/format';
import { startingProfiles } from '../store/starting';
import { appendNotices, readConfig, writeConfig } from '../store/stores';
import { line } from '../util/out';
import { decideStops } from './decide';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(text: string): void {
  line(`[agent ${formatClock()}] ${text}`);
}

export async function agentTick(runtime: Runtime): Promise<void> {
  const config = readConfig(runtime.dataDir);
  if (!config.token) {
    log('токен не задан, жду ./stand login');
    return;
  }
  const result = await fetchSession(
    config.platformUrl ?? runtime.platformUrl,
    config.token,
    runtime.version,
  );
  const containers = await listKitContainers();
  const stops = decideStops({
    result,
    runningProfiles: runningProfiles(containers),
    startingProfiles: startingProfiles(runtime.dataDir),
    lastSession: config.session,
    lastOkAt: config.lastOkAt ? Date.parse(config.lastOkAt) : null,
    now: Date.now(),
  });
  if (result.ok) {
    writeConfig(runtime.dataDir, { session: result.session, lastOkAt: new Date().toISOString() });
    log('сессия обновлена');
  } else {
    log(result.message);
  }
  for (const stop of stops) {
    const stopped = await stopProfile(stop.profile);
    log(`${stop.title ?? stop.profile}: ${stop.reason}${stopped ? '' : ' (остановить не удалось)'}`);
  }
  appendNotices(
    runtime.dataDir,
    stops.map((stop) => ({
      at: new Date().toISOString(),
      moduleKey: stop.moduleKey,
      title: stop.title,
      reason: stop.reason,
    })),
  );
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
