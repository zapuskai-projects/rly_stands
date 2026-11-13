import type { Runtime } from '../config';
import type { Progress } from '../modules/lifecycle';
import { defaultReconcileDeps, reconcileContainers, type ReconcileDeps } from '../modules/reconcile';
import { clearUpdateMarker, readUpdateMarker } from '../store/stores';
import type { Session } from '../platform/types';
import { compareVersions } from '../util/version';
import { startingProfiles } from '../store/starting';

export async function reconcileAfterUpdate(
  runtime: Runtime,
  session: Session,
  progress: Progress,
  deps: ReconcileDeps = defaultReconcileDeps(runtime, progress),
): Promise<boolean> {
  const marker = readUpdateMarker(runtime.dataDir);
  if (!marker || compareVersions(runtime.version, marker.version) < 0) return true;
  const starting = startingProfiles(runtime.dataDir);
  if (starting.length) {
    const titles = starting.map((profile) => session.modules.find((module) => module.profile === profile)?.title ?? profile);
    progress.info(`Обновление контейнеров отложено: сейчас запускается ${titles.join(', ')}. Продолжу при следующем запуске ./stand.`);
    return false;
  }
  const ok = await reconcileContainers(session, runtime.version, progress, deps, marker.profiles, marker.approved);
  if (ok) clearUpdateMarker(runtime.dataDir);
  return ok;
}
