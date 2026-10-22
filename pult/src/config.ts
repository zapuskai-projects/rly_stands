import { readFileSync } from 'node:fs';

export const PROJECT = 'stands-kit';
export const MODULE_LABEL = 'stands.kit.module';
export const DEFAULT_PLATFORM_URL = 'https://api.education.zapuskai.com';

export type Runtime = {
  version: string;
  platformUrl: string;
  dataDir: string;
  kitDir: string;
  hostDir: string;
  composeFile: string;
  agentIntervalSec: number;
  memoryTotalOverrideMb: number | null;
};

function readVersion(env: NodeJS.ProcessEnv, kitDir: string): string {
  if (env.KIT_VERSION) return env.KIT_VERSION.trim();
  try {
    return readFileSync(`${kitDir}/VERSION`, 'utf8').trim();
  } catch {
    return '0.0.0';
  }
}

function positiveInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function loadRuntime(env: NodeJS.ProcessEnv = process.env): Runtime {
  const kitDir = env.KIT_DIR ?? '/kit';
  return {
    version: readVersion(env, kitDir),
    platformUrl: (env.STAND_PLATFORM_URL ?? DEFAULT_PLATFORM_URL).replace(/\/+$/, ''),
    dataDir: env.KIT_DATA_DIR ?? '/data',
    kitDir,
    hostDir: env.KIT_HOST_DIR ?? kitDir,
    composeFile: env.KIT_COMPOSE_FILE ?? `${kitDir}/compose.yaml`,
    agentIntervalSec: positiveInt(env.KIT_AGENT_INTERVAL_SEC) ?? 600,
    memoryTotalOverrideMb: positiveInt(env.STAND_MEMORY_TOTAL_MB),
  };
}
