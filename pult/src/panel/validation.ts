import type { ActionRequest } from '../actions/types';
import { PanelError, requireObject, stringField } from './errors';

export function parseAction(value: unknown, internal = false): ActionRequest {
  const body = requireObject(value, ['action', 'target', 'version', 'clientRequestId', ...(internal ? ['moduleKey', 'selector', 'labId', 'yes', 'reset'] : [])]);
  const action = stringField(body.action);
  if (['module.start', 'module.stop', 'module.restart', 'module.reset'].includes(action)) return { action: action as 'module.start', moduleKey: stringField(body.target ?? body.moduleKey) };
  if (['task.start', 'task.restart'].includes(action)) return { action: action as 'task.start', selector: stringField(body.target ?? body.selector) };
  if (action === 'update.prepare') return { action, version: stringField(body.version, 64) };
  if (action === 'task.check') {
    const id = body.target ?? body.labId;
    return id === undefined ? { action } : { action, labId: stringField(id) };
  }
  if (internal && action === 'task.verify' && typeof body.yes === 'boolean' && typeof body.reset === 'boolean') return { action, selector: stringField(body.selector), yes: body.yes, reset: body.reset };
  if (['project.ensureStarted', 'modules.stopAll', 'diagnostics.run', 'platform.refresh', 'platform.logout', 'update.complete', ...(internal ? ['policy.enforce'] : [])].includes(action)) return { action } as ActionRequest;
  throw new PanelError(400, 'ACTION_UNAVAILABLE', 'Неизвестное действие');
}
export function pageNumber(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > max) throw new PanelError(400, 'INVALID_PAGE', 'Недопустимая страница');
  return result;
}
