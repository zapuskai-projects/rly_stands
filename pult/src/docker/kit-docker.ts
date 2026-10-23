import { MODULE_LABEL, PROJECT, type Runtime } from '../config';
import { readBankSecret } from '../store/stores';
import { run, runStreaming } from './exec';

export type KitContainer = { name: string; profile: string; running: boolean };

export type DockerInfo = { ok: true; memTotalMb: number; serverVersion: string } | { ok: false };

export async function dockerInfo(): Promise<DockerInfo> {
  const result = await run('docker', ['info', '--format', '{{.MemTotal}}|{{.ServerVersion}}']);
  if (result.code !== 0) return { ok: false };
  const [memory, version] = result.stdout.trim().split('|');
  return {
    ok: true,
    memTotalMb: Math.floor(Number(memory) / (1024 * 1024)),
    serverVersion: version ?? '',
  };
}

export async function memoryTotalMb(runtime: Runtime): Promise<number | null> {
  if (runtime.memoryTotalOverrideMb) return runtime.memoryTotalOverrideMb;
  const info = await dockerInfo();
  return info.ok ? info.memTotalMb : null;
}

export async function listKitContainers(): Promise<KitContainer[]> {
  const result = await run('docker', [
    'ps',
    '-a',
    '--filter',
    `label=${MODULE_LABEL}`,
    '--format',
    `{{.Names}}|{{.Label "${MODULE_LABEL}"}}|{{.State}}`,
  ]);
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [name = '', profile = '', state = ''] = row.split('|');
      return { name, profile, running: state === 'running' };
    });
}

export function runningProfiles(containers: KitContainer[]): string[] {
  return [...new Set(containers.filter((c) => c.running).map((c) => c.profile))];
}

export type ModuleState = 'running' | 'partial' | 'stopped';

export function profileState(containers: KitContainer[], profile: string): ModuleState {
  const own = containers.filter((c) => c.profile === profile);
  if (!own.length || own.every((c) => !c.running)) return 'stopped';
  return own.every((c) => c.running) ? 'running' : 'partial';
}

function composeArgs(runtime: Runtime, profiles: string[], tail: string[]): string[] {
  return [
    'compose',
    '-p',
    PROJECT,
    '-f',
    runtime.composeFile,
    ...profiles.flatMap((profile) => ['--profile', profile]),
    ...tail,
  ];
}

function composeEnv(runtime: Runtime): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KIT_HOST_DIR: runtime.hostDir,
    KIT_VERSION: runtime.version,
    KIT_SECRET: readBankSecret(runtime.dataDir) ?? '',
  };
}

export function composeUp(
  runtime: Runtime,
  profiles: string[],
  onLine: (line: string) => void,
): Promise<number> {
  return runStreaming('docker', composeArgs(runtime, profiles, ['up', '-d']), onLine, {
    env: composeEnv(runtime),
    cwd: runtime.kitDir,
  });
}

/** Итоговый compose для профилей: сервисы, образы, порты — то, что поднимется. */
export async function composeConfig(runtime: Runtime, profiles: string[]): Promise<unknown | null> {
  const result = await run('docker', composeArgs(runtime, profiles, ['config', '--format', 'json']), {
    env: composeEnv(runtime),
    cwd: runtime.kitDir,
  });
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

export async function localImages(): Promise<Set<string> | null> {
  const result = await run('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}']);
  if (result.code !== 0) return null;
  return new Set(result.stdout.split('\n').filter(Boolean));
}

export async function kitPublishedPorts(): Promise<string> {
  const result = await run('docker', ['ps', '--filter', `label=${MODULE_LABEL}`, '--format', '{{.Ports}}']);
  return result.code === 0 ? result.stdout : '';
}

async function profileContainerNames(profile: string, onlyRunning: boolean): Promise<string[]> {
  const containers = await listKitContainers();
  return containers
    .filter((c) => c.profile === profile && (!onlyRunning || c.running))
    .map((c) => c.name);
}

export async function stopProfile(profile: string): Promise<boolean> {
  const names = await profileContainerNames(profile, true);
  if (!names.length) return true;
  return (await run('docker', ['stop', '-t', '15', ...names])).code === 0;
}

export async function resetProfile(profile: string): Promise<boolean> {
  const names = await profileContainerNames(profile, false);
  if (names.length) await run('docker', ['rm', '-f', ...names]);
  const volumes = await run('docker', [
    'volume',
    'ls',
    '-q',
    '--filter',
    `label=${MODULE_LABEL}=${profile}`,
  ]);
  const ids = volumes.stdout.split('\n').filter(Boolean);
  if (!ids.length) return true;
  return (await run('docker', ['volume', 'rm', ...ids])).code === 0;
}
