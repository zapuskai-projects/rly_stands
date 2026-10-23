import { statfsSync } from 'node:fs';
import { connect } from 'node:net';
import type { Runtime } from '../config';
import {
  composeConfig,
  kitPublishedPorts,
  listKitContainers,
  localImages,
  memoryTotalMb,
  profileState,
} from '../docker/kit-docker';
import type { SessionModule } from '../platform/types';
import type { MemoryModule } from './memory';

const HEADROOM_PERCENT = 110;
/** Образ стенда в распакованном виде — в среднем около 700 МБ (базы, брокеры, банк); плюс данные стендов. */
export const DISK_PER_IMAGE_MB = 700;
export const DISK_FOR_DATA_MB = 1024;
const PORT_PROBE_MS = 700;

const gb = (mb: number) => (mb / 1024).toFixed(1).replace('.', ',');

export function memoryProblem(totalMb: number | null, modules: MemoryModule[]): string | null {
  if (totalMb === null) return null;
  const needMb = Math.ceil((modules.reduce((sum, item) => sum + item.minMemoryMb, 0) * HEADROOM_PERCENT) / 100);
  if (totalMb >= needMb) return null;
  return `Проекту нужно ${gb(needMb)} ГБ памяти Docker, отдано ${gb(totalMb)} ГБ. Прибавьте в Docker Desktop: Settings → Resources → Memory`;
}

export function diskProblem(freeMb: number | null, missingImages: number): string | null {
  if (freeMb === null) return null;
  const needMb = DISK_FOR_DATA_MB + missingImages * DISK_PER_IMAGE_MB;
  if (freeMb >= needMb) return null;
  const what = missingImages ? 'чтобы скачать образы проекта' : 'для данных стендов';
  return `На диске Docker свободно ${gb(freeMb)} ГБ, ${what} нужно около ${gb(needMb)} ГБ. Удалите ненужные образы в Docker Desktop (Images) или увеличьте диск: Settings → Resources → Disk`;
}

export type PortNeed = { port: number; profile: string };

type ComposeService = { profiles?: unknown; image?: unknown; ports?: unknown };

function servicesOf(config: unknown): ComposeService[] {
  const services = (config as { services?: Record<string, ComposeService> } | null)?.services;
  return services && typeof services === 'object' ? Object.values(services) : [];
}

function profilesOf(service: ComposeService): string[] {
  return Array.isArray(service.profiles) ? service.profiles.map(String) : [];
}

export function composeImages(config: unknown, profiles: string[]): string[] {
  const images = servicesOf(config)
    .filter((service) => profilesOf(service).some((profile) => profiles.includes(profile)))
    .map((service) => (typeof service.image === 'string' ? service.image : null))
    .filter((image): image is string => Boolean(image));
  return [...new Set(images)];
}

export function composePorts(config: unknown, profiles: string[]): PortNeed[] {
  const needs: PortNeed[] = [];
  for (const service of servicesOf(config)) {
    const profile = profilesOf(service).find((item) => profiles.includes(item));
    if (!profile || !Array.isArray(service.ports)) continue;
    for (const entry of service.ports as Array<{ published?: unknown }>) {
      const port = Number(entry?.published);
      if (Number.isInteger(port) && port > 0) needs.push({ port, profile });
    }
  }
  return needs;
}

/** «127.0.0.1:15432->5432/tcp, [::]:8080->8080/tcp» → порты на компьютере. */
export function parsePublishedPorts(text: string): Set<number> {
  const ports = new Set<number>();
  for (const match of text.matchAll(/:(\d+)->/g)) ports.add(Number(match[1]));
  return ports;
}

/** Docker пишет «docker.io/library/postgres:16» как «postgres:16», а образ без тега — это latest. */
export function normalizeImage(image: string): string {
  const name = image.replace(/^docker\.io\//, '').replace(/^library\//, '');
  const last = name.split('/').at(-1) ?? name;
  return last.includes(':') || last.includes('@') ? name : `${name}:latest`;
}

export function isImageLocal(image: string, local: Set<string>): boolean {
  const wanted = normalizeImage(image);
  return [...local].some((item) => normalizeImage(item) === wanted);
}

export function portProblems(needs: PortNeed[], busy: Set<number>, titles: Map<string, string>): string[] {
  return needs
    .filter((need) => busy.has(need.port))
    .map(
      (need) =>
        `Порт ${need.port} занят другой программой, а он нужен стенду «${titles.get(need.profile) ?? need.profile}». Закройте её (найти: lsof -i :${need.port}) и запустите ./stand start снова`,
    );
}

function portAnswers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: 'host.docker.internal', port, timeout: PORT_PROBE_MS });
    const done = (busy: boolean) => {
      socket.destroy();
      resolve(busy);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function dockerDiskFreeMb(): number | null {
  try {
    const stats = statfsSync('/');
    return Math.floor((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
  } catch {
    return null;
  }
}

/**
 * До скачивания образов: хватит ли памяти и диска Docker, свободны ли порты проекта.
 * Пульт работает в контейнере на том же диске Docker, поэтому свободное место — это место пульта.
 */
export async function preflight(runtime: Runtime, modules: SessionModule[]): Promise<string[]> {
  const problems: string[] = [];
  const memory = memoryProblem(await memoryTotalMb(runtime), modules);
  if (memory) problems.push(memory);

  const containers = await listKitContainers();
  const waiting = modules.filter((module) => profileState(containers, module.profile) !== 'running');
  if (!waiting.length) return problems;
  const profiles = waiting.map((module) => module.profile);
  const config = await composeConfig(runtime, profiles);
  if (!config) return problems;

  const local = await localImages();
  const images = composeImages(config, profiles);
  const missing = local ? images.filter((image) => !isImageLocal(image, local)).length : images.length;
  const disk = diskProblem(dockerDiskFreeMb(), missing);
  if (disk) problems.push(disk);

  const ours = parsePublishedPorts(await kitPublishedPorts());
  const needs = composePorts(config, profiles).filter((need) => !ours.has(need.port));
  const answers = await Promise.all(needs.map((need) => portAnswers(need.port)));
  const busy = new Set(needs.filter((_, index) => answers[index]).map((need) => need.port));
  const titles = new Map(modules.map((module) => [module.profile, module.title]));
  problems.push(...portProblems(needs, busy, titles));
  return problems;
}
