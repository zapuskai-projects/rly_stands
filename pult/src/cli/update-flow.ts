import type { Runtime } from '../config';
import type { Progress } from '../modules/lifecycle';
import { defaultReconcileDeps, reconcileContainers, recreatedAutomatically, staleContainers, type ReconcileDeps } from '../modules/reconcile';
import { clearUpdateMarker, readUpdateMarker, writeUpdateMarker } from '../store/stores';
import type { Session } from '../platform/types';
import { compareVersions } from '../util/version';
import { startingProfiles } from '../store/starting';
import { askYesNo, exitPult, isInteractive } from './idle';
import type { SessionContext } from './session';
import { defaultPrepareDeps, offerUpdate, prepareUpdate, type OfferOutcome, type UpdateOffers } from './update';

const ASK_SETTLE_MS = 700;

export type UpdateRequest = {
  runtime: Runtime;
  ctx: SessionContext;
  offers: UpdateOffers;
  atLaunch: boolean;
  progress: Progress;
  say: (text: string) => void;
  ask?: (question: string) => Promise<boolean>;
  interactive?: boolean;
  prepare?: (version: string) => Promise<boolean>;
};

export function runUpdateOffer(request: UpdateRequest): Promise<OfferOutcome> {
  const { runtime, ctx, progress } = request;
  return offerUpdate({
    runtime,
    ctx,
    interactive: request.interactive ?? isInteractive(),
    offers: request.offers,
    atLaunch: request.atLaunch,
    ask: request.ask ?? ((question) => askYesNo(question, { settleMs: ASK_SETTLE_MS, onInterrupt: exitPult })),
    say: request.say,
    prepare:
      request.prepare ??
      ((version) =>
      prepareUpdate(
        version,
        runtime.version,
        progress,
        defaultPrepareDeps(
          version,
          async () => (await staleContainers(defaultReconcileDeps(runtime, progress), version))?.filter(recreatedAutomatically) ?? null,
          (accepted, profiles) => writeUpdateMarker(runtime.dataDir, accepted, profiles),
        ),
      )),
  });
}

/** После обновления, на которое студент согласился: пересоздаёт контейнеры с устаревшим образом, данные не трогает. */
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
  const ok = await reconcileContainers(session, runtime.version, progress, deps, marker.profiles);
  if (ok) clearUpdateMarker(runtime.dataDir);
  return ok;
}
