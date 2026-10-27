import type { Runtime } from '../config';
import { composeConfig, hasImage, listRunningImages, pullImage, recreateService, type RunningImage } from '../docker/kit-docker';
import type { Session } from '../platform/types';
import { asRecord } from '../probes/http';
import type { Progress } from './lifecycle';
import { pullTracker } from './pull';
import { READINESS, waitReady } from './readiness';

export type ComposeService = { service: string; container: string; image: string; profiles: string[]; dependsOn: string[] };
export type StaleService = { wanted: ComposeService; running: RunningImage };

const AGENT_TITLE = 'служебный агент';
const SECONDS_BY_PROFILE: Record<string, number> = { bank: 20 };
const DEFAULT_SECONDS = 40;
const PROFILES_WITH_DATA_IN_LAYER = new Set(['linux']);

export function composeServices(config: unknown): ComposeService[] {
  const services = asRecord(asRecord(config).services);
  return Object.entries(services).flatMap(([service, value]) => {
    const row = asRecord(value);
    const image = typeof row.image === 'string' ? row.image : '';
    const container = typeof row.container_name === 'string' ? row.container_name : '';
    if (!image || !container) return [];
    const profiles = Array.isArray(row.profiles) ? row.profiles.filter((item): item is string => typeof item === 'string') : [];
    const dependsOn = Object.keys(asRecord(row.depends_on));
    return [{ service, container, image, profiles, dependsOn }];
  });
}

export function staleServices(wanted: ComposeService[], running: RunningImage[]): StaleService[] {
  const byName = new Map(running.map((item) => [item.name, item]));
  return wanted.flatMap((service) => {
    const current = byName.get(service.container);
    return current && current.image !== service.image ? [{ wanted: service, running: current }] : [];
  });
}

/** Пересоздаём сами только то, где нет данных студента в слое контейнера: банк (базы в томах) и служебный агент. */
export const recreatedAutomatically = (item: StaleService): boolean =>
  item.wanted.service.startsWith('kit-bank-') || item.wanted.service === 'kit-agent';

export function inDependencyOrder(stale: StaleService[]): StaleService[] {
  const names = new Set(stale.map((item) => item.wanted.service));
  const placed: StaleService[] = [];
  const left = [...stale];
  while (left.length) {
    const next = left.findIndex((item) => item.wanted.dependsOn.every((name) => !names.has(name) || placed.some((done) => done.wanted.service === name)));
    placed.push(...left.splice(next === -1 ? 0 : next, 1));
  }
  return placed;
}

export function imagesToPull(stale: StaleService[]): string[] {
  return [...new Set(stale.map((item) => item.wanted.image))];
}

export function profilesOf(running: RunningImage[]): string[] {
  return [...new Set(running.map((item) => item.profile).filter(Boolean))];
}

export type ReconcileDeps = {
  listRunning: () => Promise<RunningImage[] | null>;
  config: (profiles: string[], version: string) => Promise<unknown | null>;
  hasImage: (image: string) => Promise<boolean>;
  pull: (image: string, onLine: (line: string) => void) => Promise<number>;
  recreate: (profiles: string[], service: string, onLine: (line: string) => void) => Promise<number>;
  ready: (profile: string) => Promise<boolean>;
};

export async function staleContainers(deps: Pick<ReconcileDeps, 'listRunning' | 'config'>, version: string): Promise<StaleService[] | null> {
  const running = await deps.listRunning();
  if (!running) return null;
  const config = await deps.config(profilesOf(running), version);
  return config ? staleServices(composeServices(config), running) : null;
}

export function defaultReconcileDeps(runtime: Runtime, progress: Progress): ReconcileDeps {
  return {
    listRunning: listRunningImages,
    config: (profiles, version) => composeConfig(runtime, profiles, version),
    hasImage,
    pull: pullImage,
    recreate: (profiles, service, onLine) => recreateService(runtime, profiles, service, onLine),
    ready: async (profile) => {
      const reports = await waitReady(READINESS[profile] ?? [], runtime.kitDir, (report) => {
        if (report.ok) progress.ok(`  ${report.label} отвечает (${report.seconds} с)`);
        else if (!report.skipped) progress.fail(`  ${report.label} не ответил за ${report.seconds} с`);
      });
      return reports.every((report) => report.ok);
    },
  };
}

function titleOf(session: Session, profile: string): string {
  if (!profile) return AGENT_TITLE;
  if (profile === 'bank') return 'банк';
  return session.modules.find((module) => module.profile === profile)?.title ?? profile;
}

export function manualUpdateNote(session: Session, item: StaleService): string {
  const profile = item.running.profile;
  const title = session.modules.find((module) => module.profile === profile)?.title ?? item.wanted.container;
  return `${title} обновится, когда вы его перезапустите${PROFILES_WITH_DATA_IN_LAYER.has(profile) ? ' (данные внутри сбросятся)' : ''}`;
}

function missingRequirements(session: Session, profile: string, active: Set<string>): string[] {
  const module = session.modules.find((item) => item.profile === profile);
  return (module?.requires ?? []).flatMap((key) => {
    const required = session.modules.find((item) => item.key === key);
    return required && !active.has(required.profile) ? [required.title] : [];
  });
}

export const CHECK_FAILED = 'Не удалось сверить контейнеры с новой версией: Docker не ответил. Попробую при следующем запуске ./stand.';

async function pullMissing(images: string[], progress: Progress, deps: ReconcileDeps): Promise<boolean> {
  for (const image of images) {
    if (await deps.hasImage(image)) continue;
    progress.info(`Скачиваю ${image}`);
    if ((await deps.pull(image, pullTracker((text) => progress.info(text)))) !== 0) {
      progress.fail(`Образ ${image} не скачался. Попробую при следующем запуске ./stand.`);
      return false;
    }
  }
  return true;
}

/** Пересоздаёт по одному контейнеры с устаревшим образом, тома и файлы студента не затрагиваются; `awaited` — профили, готовность которых ждём, даже если пересоздавать уже нечего. */
export async function reconcileContainers(
  session: Session,
  version: string,
  progress: Progress,
  deps: ReconcileDeps,
  awaited: string[] = [],
): Promise<boolean> {
  const stale = await staleContainers(deps, version);
  if (!stale) {
    progress.fail(CHECK_FAILED);
    return false;
  }
  for (const item of stale.filter((entry) => !recreatedAutomatically(entry))) progress.info(manualUpdateNote(session, item));
  const own = inDependencyOrder(stale.filter(recreatedAutomatically));
  if (!(await pullMissing(imagesToPull(own), progress, deps))) return false;
  const profiles = [...new Set(own.map((item) => item.running.profile))];
  const active = new Set((await deps.listRunning())?.map((item) => item.profile));
  let allOk = true;
  for (const profile of profiles) {
    const title = titleOf(session, profile);
    const missing = missingRequirements(session, profile, active);
    if (missing.length) {
      progress.info(`Обновление отложено (${title}): сначала нужно запустить ${missing.join(', ')}. Продолжу при следующем запуске ./stand.`);
      allOk = false;
      continue;
    }
    let profileOk = true;
    progress.info(`Обновляю ${title} до ${version}, около ${SECONDS_BY_PROFILE[profile] ?? DEFAULT_SECONDS} секунд`);
    for (const item of own.filter((entry) => entry.running.profile === profile)) {
      const code = await deps.recreate(profile ? [profile] : [], item.wanted.service, () => undefined);
      if (code !== 0) {
        progress.fail(`${title}: не удалось пересоздать ${item.wanted.container}`);
        profileOk = false;
      }
    }
    if (profileOk && profile) profileOk = await deps.ready(profile);
    if (profileOk) progress.ok(`${title} обновлён до ${version}, данные на месте`);
    else allOk = false;
  }
  const running = await deps.listRunning();
  for (const profile of awaited.filter((name) => !profiles.includes(name))) {
    if (!running?.some((item) => item.profile === profile)) continue;
    if (await deps.ready(profile)) progress.ok(`${titleOf(session, profile)} обновлён до ${version}, данные на месте`);
    else allOk = false;
  }
  return allOk;
}
