import { isRequiredByRunning } from '../modules/requires';
import type { Session, SessionResult } from '../platform/types';

export type StopAction = {
  profile: string;
  moduleKey: string | null;
  title: string | null;
  reason: string;
};

export type AgentInput = {
  result: SessionResult;
  runningProfiles: string[];
  startingProfiles?: string[];
  lastSession: Session | null;
  lastOkAt: number | null;
  now: number;
};

const HOUR_MS = 3600 * 1000;
export const REASON_DISABLED = 'выключен на платформе';
export const REASON_PROJECT_CLOSED = 'проект закрыт — спросите куратора';
export const REASON_NOT_ASSIGNED = 'не назначен';
export const REASON_TOKEN = 'токен отозван или истёк — получите новый на платформе и выполните ./stand login';

function describe(session: Session | null, profile: string) {
  const module = session?.modules.find((item) => item.profile === profile);
  return { moduleKey: module?.key ?? null, title: module?.title ?? null };
}

function stopAll(input: AgentInput, reason: string): StopAction[] {
  return input.runningProfiles.map((profile) => ({
    profile,
    ...describe(input.lastSession, profile),
    reason,
  }));
}

export function decideStops(input: AgentInput): StopAction[] {
  const { result } = input;
  if (!result.ok && result.kind === 'rejected') return stopAll(input, REASON_TOKEN);
  if (!result.ok) {
    const graceHours = input.lastSession?.kit.offlineGraceHours;
    if (!graceHours || input.lastOkAt === null) return [];
    const silentMs = input.now - input.lastOkAt;
    return silentMs > graceHours * HOUR_MS
      ? stopAll(input, `нет связи с платформой дольше ${graceHours} ч`)
      : [];
  }
  const actions: StopAction[] = [];
  const active = [...input.runningProfiles, ...(input.startingProfiles ?? [])];
  for (const profile of input.runningProfiles) {
    const module = result.session.modules.find((item) => item.profile === profile);
    if (!module) {
      const before = input.lastSession?.modules.find((item) => item.profile === profile);
      const reason = before?.project ? REASON_PROJECT_CLOSED : REASON_DISABLED;
      actions.push({ profile, ...describe(input.lastSession, profile), reason });
    } else if (!module.allowed && !isRequiredByRunning(result.session, module, active)) {
      actions.push({
        profile,
        moduleKey: module.key,
        title: module.title,
        reason: module.reason ?? REASON_NOT_ASSIGNED,
      });
    }
  }
  return actions;
}
