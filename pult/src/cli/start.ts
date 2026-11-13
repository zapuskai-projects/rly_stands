import type { Runtime } from '../config';
import type { Progress } from '../modules/lifecycle';
import type { Session } from '../platform/types';
import { requestOpen } from '../util/open-url';
import { line } from '../util/out';
import { dispatchAction } from '../actions/dispatcher';
import { taskConfirmation, printDefinition } from './tasks';
export { currentTicket, idleModules, mainModule, projectModules, startupModules, ticketNeedsStart, ticketUrl, type StartOutcome } from '../actions/project';

export async function startProjectFlow(runtime: Runtime, session: Session, progress: Progress, stale = false) {
  const result = await dispatchAction({ runtime, session, stale, progress, ask: taskConfirmation,
    showTask: printDefinition, say: line, open: (url) => { requestOpen(runtime, url); } }, { action: 'project.ensureStarted' });
  return result.project ?? { code: 1, hasProject: true };
}
