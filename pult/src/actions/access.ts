import type { Runtime } from '../config';
import { listKitContainers, runningProfiles, stopProfile } from '../docker/kit-docker';
import { fetchSession } from '../platform/client';
import { startingProfiles } from '../store/starting';
import { appendNotices, readConfig, writeConfig } from '../store/stores';
import { decideStops } from '../agent/decide';

export async function enforceAccess(runtime: Runtime, log: (text: string) => void): Promise<void> {
  const config = readConfig(runtime.dataDir);
  if (!config.token && !config.session) {
    log('токен не задан, жду ./stand login');
    return;
  }
  const result = config.token ? await fetchSession(
    config.platformUrl ?? runtime.platformUrl,
    config.token,
    runtime.version,
  ) : { ok: false as const, kind: 'rejected' as const, message: 'Токен не задан или отозван' };
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

