import type { Runtime } from '../config';
import { listKitContainers, profileState } from '../docker/kit-docker';
import { startModule, waitModuleReady, type Progress } from '../modules/lifecycle';
import type { Session } from '../platform/types';
import type { CurrentTask } from '../store/stores';

export async function resumeTaskModules(
  runtime: Runtime,
  session: Session,
  task: CurrentTask,
  progress: Progress,
  beforeStep?: () => Promise<void>,
): Promise<boolean> {
  const checked = new Set<string>();
  async function ensure(key: string): Promise<boolean> {
    if (checked.has(key)) return true;
    const module = session.modules.find((item) => item.key === key);
    if (!module?.allowed) {
      progress.fail(module?.reason ?? `Стенд ${module?.title ?? key} недоступен`);
      return false;
    }
    checked.add(key);
    for (const dependency of module.requires ?? []) {
      if (!(await ensure(dependency))) return false;
    }
    await beforeStep?.();
    const containers = await listKitContainers();
    if (profileState(containers, module.profile) === 'running') return waitModuleReady(runtime, module, progress);
    progress.info(`Восстанавливаю стенд «${module.title}»`);
    return startModule(runtime, session, module, progress, { beforeStep });
  }
  for (const module of task.modules) {
    if (!(await ensure(module.key))) return false;
  }
  return true;
}
