import type { KitContainer } from '../docker/kit-docker';
import { profileState } from '../docker/kit-docker';
import type { Session, SessionModule } from '../platform/types';
import { checkMemory, memoryRefusal } from './memory';
import { requirerOf } from './requires';

export type RowState = 'running' | 'partial' | 'stopped' | 'unavailable';

export type ModuleRow = {
  key: string;
  title: string;
  profile: string;
  state: RowState;
  note: string;
};

function runningModules(modules: SessionModule[], containers: KitContainer[]) {
  return modules.filter((module) => profileState(containers, module.profile) !== 'stopped');
}

export function buildRows(
  session: Session,
  containers: KitContainer[],
  memoryTotalMb: number | null,
): ModuleRow[] {
  const running = runningModules(session.modules, containers);
  return session.modules.map((module) => {
    const base = { key: module.key, title: module.title, profile: module.profile };
    const state = profileState(containers, module.profile);
    if (!module.allowed) {
      const requirer = state === 'stopped' ? undefined : requirerOf(session, module, running.map((item) => item.profile));
      const note = requirer ? `нужен для «${requirer.title}»` : (module.reason ?? 'недоступен');
      return { ...base, state: state === 'stopped' ? 'unavailable' : state, note };
    }
    if (state === 'running') {
      const panel = module.uis[0];
      return { ...base, state, note: panel ? `панель: ${panel.url}` : '' };
    }
    if (state === 'partial') return { ...base, state, note: 'запущен не полностью' };
    if (memoryTotalMb !== null) {
      const verdict = checkMemory(
        memoryTotalMb,
        running.filter((item) => item.key !== module.key),
        module,
      );
      if (!verdict.ok) {
        return { ...base, state: 'unavailable', note: memoryRefusal(verdict) };
      }
    }
    return { ...base, state, note: '' };
  });
}

export function findModule(session: Session, name: string): SessionModule | undefined {
  const wanted = name.trim().toLowerCase();
  return session.modules.find(
    (module) => module.key.toLowerCase() === wanted || module.profile.toLowerCase() === wanted,
  );
}
