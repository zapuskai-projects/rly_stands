import type { Session, SessionModule } from '../platform/types';

export type RequiredModules = { modules: SessionModule[]; missing: string[] };

export function requiredModules(session: Session, module: SessionModule): RequiredModules {
  const modules: SessionModule[] = [];
  const missing: string[] = [];
  for (const key of module.requires ?? []) {
    const found = session.modules.find((item) => item.key === key);
    if (found) modules.push(found);
    else missing.push(key);
  }
  return { modules, missing };
}

export function requirerOf(session: Session, module: SessionModule, runningProfiles: string[]): SessionModule | undefined {
  return session.modules.find(
    (item) =>
      item.allowed && runningProfiles.includes(item.profile) && (item.requires ?? []).includes(module.key),
  );
}

export function isRequiredByRunning(session: Session, module: SessionModule, runningProfiles: string[]): boolean {
  return requirerOf(session, module, runningProfiles) !== undefined;
}
