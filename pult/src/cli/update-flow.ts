import type { Runtime } from '../config';
import type { Progress } from '../modules/lifecycle';
import { askYesNo, exitPult, isInteractive } from './idle';
import type { SessionContext } from './session';
import { offerUpdate, type OfferOutcome, type UpdateOffers } from './update';
import { dispatchAction } from '../actions/dispatcher';
import type { Session } from '../platform/types';
import type { ReconcileDeps } from '../modules/reconcile';

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
      (async (version) => (await dispatchAction({ runtime, session: ctx.session, stale: ctx.stale, progress, confirmed: true }, { action: 'update.prepare', version })).ok),
  });
}

export async function reconcileAfterUpdate(runtime: Runtime, session: Session, progress: Progress, deps?: ReconcileDeps): Promise<boolean> {
  return (await dispatchAction({ runtime, session, progress, reconcileDeps: deps }, { action: 'update.complete' })).ok;
}
