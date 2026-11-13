import type { Runtime } from '../config';
import type { Progress } from '../modules/lifecycle';
import type { CheckOutcome, Session } from '../platform/types';
import type { CurrentTask } from '../store/stores';
import type { SessionContext } from './session';
import type { ReconcileDeps } from '../modules/reconcile';
import type { Diagnostic } from './doctor';
import type { StartOutcome } from './project';

type UntargetedAction = 'modules.stopAll' | 'project.ensureStarted' | 'diagnostics.run' | 'platform.refresh' | 'platform.logout' | 'policy.enforce';

export type ActionRequest =
  | { action: 'module.start' | 'module.stop' | 'module.restart' | 'module.reset'; moduleKey: string }
  | { [K in UntargetedAction]: { action: K } }[UntargetedAction]
  | { action: 'task.start' | 'task.restart'; selector: string }
  | { action: 'task.check'; labId?: string }
  | { action: 'task.verify'; selector: string; yes: boolean; reset: boolean }
  | { action: 'update.prepare'; version: string }
  | { action: 'update.complete' };

export type ActionContext = {
  runtime: Runtime;
  session?: Session;
  stale?: boolean;
  progress: Progress;
  ask?: (message: string) => Promise<boolean>;
  confirmed?: boolean;
  showTask?: (task: CurrentTask) => void;
  open?: (url: string) => void;
  say?: (text?: string) => void;
  diagnostic?: (verdict: Diagnostic['verdict'], text: string) => void;
  revalidate?: () => Promise<{ session: Session; stale: boolean } | null>;
  approvedUpdates?: string[];
  beforeStep?: () => Promise<void>;
  reconcileDeps?: ReconcileDeps;
};

export type ActionResult = { ok: boolean; code?: string; message?: string; check?: CheckOutcome | null; project?: StartOutcome; diagnostics?: Diagnostic[]; sessionContext?: SessionContext | null };
export type ActionPlan = { approvedUpdates?: string[]; allowed: boolean; code?: string; reason?: string; targets: string[]; consequences: string[]; confirmationRequired: boolean };
