import type { Runtime } from '../config';
import {
  composeUp,
  startExistingContainers,
  listKitContainers,
  memoryTotalMb,
  profileState,
  resetProfile,
  stopProfile,
} from '../docker/kit-docker';
import type { Session, SessionModule } from '../platform/types';
import { clearStarting, markStarting } from '../store/starting';
import { ensureBankSecret } from '../store/stores';
import { compareVersions, UPDATE_HINT } from '../util/version';
import { compatibilityRefusal, existingLaunch } from './compatibility';
import { dropBankDatabase } from './bank';
import { requiredModules } from './requires';
import { checkMemory, memoryRefusal } from './memory';
import { READINESS, waitReady } from './readiness';

export type Progress = {
  info: (text: string) => void;
  ok: (text: string) => void;
  fail: (text: string) => void;
};

const COMPOSE_LINE = /\b(Started|Created|Pulled|Error|error|denied|failed|Healthy)\b/;
const PORT_BUSY = /Bind for \S+?:(\d+) failed|address already in use/;

export function composeFailure(output: string[], code: number): string {
  for (const text of output) {
    const busy = PORT_BUSY.exec(text);
    if (busy) {
      const port = busy[1] ? `Порт ${busy[1]}` : 'Нужный порт';
      return `${port} занят другой программой или контейнером. Остановите её и запустите стенд снова`;
    }
  }
  const last = output.filter((text) => /error|denied|failed/i.test(text)).at(-1);
  return last ? last : `docker compose завершился с ошибкой ${code}`;
}

export function versionGate(runtime: Runtime, session: Session): string | null {
  return compareVersions(runtime.version, session.kit.minVersion) < 0
    ? `Версия набора ${runtime.version} устарела, нужна не ниже ${session.kit.minVersion}. ${UPDATE_HINT}`
    : null;
}

export function versionReminder(runtime: Runtime, session: Session): string | null {
  return compareVersions(runtime.version, session.kit.latestVersion) < 0
    ? `Вышла версия ${session.kit.latestVersion}, обновить: ./stand`
    : null;
}

async function memoryVerdictFor(runtime: Runtime, session: Session, module: SessionModule) {
  const total = await memoryTotalMb(runtime);
  if (total === null) return null;
  const containers = await listKitContainers();
  const running = session.modules.filter(
    (item) => item.key !== module.key && profileState(containers, item.profile) !== 'stopped',
  );
  const verdict = checkMemory(total, running, module, module.requires ?? []);
  return verdict.ok ? null : memoryRefusal(verdict);
}

async function startDependencies(
  runtime: Runtime,
  session: Session,
  module: SessionModule,
  progress: Progress,
  beforeStep?: () => Promise<void>,
): Promise<boolean> {
  const { modules, missing } = requiredModules(session, module);
  if (missing.length) {
    progress.fail(`${module.title} работает вместе со стендом ${missing.join(', ')}, а он выключен на платформе`);
    return false;
  }
  for (const dependency of modules) {
    const containers = await listKitContainers();
    if (profileState(containers, dependency.profile) === 'running') continue;
    progress.info(`${module.title}: сначала запускаю «${dependency.title}»`);
    if (!(await startModule(runtime, session, dependency, progress, { dependency: true, beforeStep }))) return false;
  }
  return true;
}

export async function startModule(
  runtime: Runtime,
  session: Session,
  module: SessionModule,
  progress: Progress,
  options: { dependency?: boolean; beforeStep?: () => Promise<void> } = {},
): Promise<boolean> {
  if (options.dependency) return launchModule(runtime, session, module, progress, options);
  markStarting(runtime.dataDir, module.profile);
  try {
    return await launchModule(runtime, session, module, progress, options);
  } finally {
    clearStarting(runtime.dataDir, module.profile);
  }
}

async function launchModule(
  runtime: Runtime,
  session: Session,
  module: SessionModule,
  progress: Progress,
  options: { dependency?: boolean; beforeStep?: () => Promise<void> },
): Promise<boolean> {
  if (!module.allowed && !options.dependency) {
    progress.fail(`${module.title}: ${module.reason ?? 'недоступен'}`);
    return false;
  }
  const gate = versionGate(runtime, session);
  if (gate) {
    progress.fail(gate);
    return false;
  }
  const incompatible = await compatibilityRefusal(runtime, session, [module]);
  if (incompatible) { progress.fail(incompatible); return false; }
  if (!(await startDependencies(runtime, session, module, progress, options.beforeStep))) return false;
  const refusal = await memoryVerdictFor(runtime, session, module);
  if (refusal) {
    progress.fail(`${module.title}: ${refusal}`);
    return false;
  }
  await options.beforeStep?.();
  if (module.profile === 'bank') ensureBankSecret(runtime.dataDir);
  progress.info(`${module.title}: запускаю контейнеры`);
  const output: string[] = [];
  const launch = await existingLaunch(runtime, module);
  if (launch.kind === 'blocked') { progress.fail(launch.reason); return false; }
  await options.beforeStep?.();
  const code = launch.kind === 'existing' ? ((await startExistingContainers(launch.names)) ? 0 : 1) : await composeUp(runtime, [module.profile], (text) => {
    output.push(text);
    if (COMPOSE_LINE.test(text) && !PORT_BUSY.test(text)) progress.info(`  ${text}`);
  });
  if (code !== 0) {
    progress.fail(`${module.title}: ${composeFailure(output, code)}`);
    return false;
  }
  const reports = await waitReady(READINESS[module.profile] ?? [], runtime.kitDir, (report) => {
    if (report.skipped) progress.info(`  ${report.label} ждёт файл ${report.skipped}`);
    else if (report.ok) progress.ok(`  ${report.label} отвечает (${report.seconds} с)`);
    else progress.fail(`  ${report.label} не ответил за ${report.seconds} с`);
  });
  if (reports.some((report) => !report.ok)) {
    progress.fail(`${module.title}: запущен не полностью, подробности — docker logs`);
    return false;
  }
  progress.ok(`${module.title} работает`);
  for (const ui of module.uis) progress.info(`  ${ui.title}: ${ui.url}`);
  return true;
}

export async function stopModule(module: SessionModule, progress: Progress): Promise<boolean> {
  const ok = await stopProfile(module.profile);
  if (ok) progress.ok(`${module.title} остановлен`);
  else progress.fail(`${module.title}: не удалось остановить`);
  return ok;
}

export async function resetModule(module: SessionModule, progress: Progress, deps = {
  reset: () => resetProfile(module.profile),
  dropBank: dropBankDatabase,
}): Promise<boolean> {
  const ok = await deps.reset();
  if (ok && module.profile === 'bank') await deps.dropBank();
  if (ok) progress.ok(`${module.title}: контейнеры и данные удалены`);
  else progress.fail(`${module.title}: не удалось удалить данные`);
  return ok;
}

export type RestartDeps = {
  compatible: () => Promise<string | null>;
  stop: () => Promise<boolean>;
  start: () => Promise<boolean>;
};

export async function restartModule(runtime: Runtime, session: Session, module: SessionModule, progress: Progress, deps: RestartDeps = {
  compatible: async () => (await compatibilityRefusal(runtime, session, [module])) ?? memoryVerdictFor(runtime, session, module),
  stop: () => stopModule(module, progress),
  start: () => startModule(runtime, session, module, progress, { beforeStep }),
}, beforeStep?: () => Promise<void>): Promise<boolean> {
  const gate = versionGate(runtime, session);
  if (gate || !module.allowed) { progress.fail(gate ?? module.reason ?? 'Стенд недоступен'); return false; }
  const refusal = await deps.compatible();
  if (refusal) { progress.fail(refusal); return false; }
  await beforeStep?.();
  if (!(await deps.stop())) return false;
  await beforeStep?.();
  return deps.start();
}
