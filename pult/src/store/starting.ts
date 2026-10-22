import { join } from 'node:path';
import { readJson, writeJson } from '../util/json-file';

export const STARTING_FRESH_MS = 30 * 60 * 1000;

type StoredStarting = { profiles: Record<string, string> };

const EMPTY: StoredStarting = { profiles: {} };

const startingPath = (dataDir: string) => join(dataDir, 'starting.json');

export function markStarting(dataDir: string, profile: string, now = Date.now()): void {
  const stored = readJson(startingPath(dataDir), EMPTY);
  writeJson(startingPath(dataDir), { profiles: { ...stored.profiles, [profile]: new Date(now).toISOString() } });
}

export function clearStarting(dataDir: string, profile: string): void {
  const profiles = { ...readJson(startingPath(dataDir), EMPTY).profiles };
  delete profiles[profile];
  writeJson(startingPath(dataDir), { profiles });
}

export function startingProfiles(dataDir: string, now = Date.now()): string[] {
  return Object.entries(readJson(startingPath(dataDir), EMPTY).profiles)
    .filter(([, since]) => now - Date.parse(since) < STARTING_FRESH_MS)
    .map(([profile]) => profile);
}
