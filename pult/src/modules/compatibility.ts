import type { Runtime } from '../config';
import { composeConfig, inspectContainerImage, listKitContainers, type KitContainer } from '../docker/kit-docker';
import type { Session, SessionModule } from '../platform/types';
import { composeServices } from './reconcile';
import { requiredModules } from './requires';

export const MIGRATION_REQUIRED = 'Linux требует отдельного переноса данных: образ контейнера отличается от ожидаемого или неизвестен. Запуск и перезапуск заблокированы; данные внутри Linux сохранены.';

export function exactImage(image: string): boolean {
  if (/@sha256:[a-f0-9]{64}$/.test(image)) return true;
  const tag = image.slice(image.lastIndexOf('/') + 1).split(':')[1];
  return Boolean(tag && /^v?\d+(?:\.\d+)+(?:[-+][A-Za-z0-9.-]+)?$/.test(tag));
}

export type CompatibilityDeps = {
  containers: () => Promise<KitContainer[]>;
  config: (profile: string) => Promise<unknown | null>;
  image: (name: string) => Promise<string | null>;
};

export type ExistingLaunch = { kind: 'new' } | { kind: 'existing'; names: string[] } | { kind: 'blocked'; reason: string };

export async function existingLaunch(runtime: Runtime, module: SessionModule, deps: CompatibilityDeps = {
  containers: listKitContainers,
  config: (profile) => composeConfig(runtime, [profile]),
  image: inspectContainerImage,
}): Promise<ExistingLaunch> {
  if (module.profile !== 'linux') return { kind: 'new' };
  const own = (await deps.containers()).filter((item) => item.profile === module.profile);
  if (!own.length) return { kind: 'new' };
  const config = await deps.config(module.profile);
  const wanted = composeServices(config).filter((service) => service.profiles.includes(module.profile));
  if (!wanted.length || own.length !== wanted.length) return { kind: 'blocked', reason: MIGRATION_REQUIRED };
  for (const container of own) {
    const expected = wanted.find((service) => service.container === container.name)?.image;
    if (!expected || !exactImage(expected) || (await deps.image(container.name)) !== expected) return { kind: 'blocked', reason: MIGRATION_REQUIRED };
  }
  return { kind: 'existing', names: own.map((item) => item.name) };
}

export async function compatibilityRefusal(runtime: Runtime, session: Session, modules: SessionModule[]): Promise<string | null> {
  const all = new Map(modules.map((module) => [module.key, module]));
  const queue = [...modules];
  for (let index = 0; index < queue.length; index += 1) {
    for (const dependency of requiredModules(session, queue[index]!).modules) {
      if (all.has(dependency.key)) continue;
      all.set(dependency.key, dependency);
      queue.push(dependency);
    }
  }
  for (const module of all.values()) {
    const launch = await existingLaunch(runtime, module);
    if (launch.kind === 'blocked') return launch.reason;
  }
  return null;
}
