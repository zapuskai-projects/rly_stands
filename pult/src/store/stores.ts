import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../platform/types';
import { readJson, writeJson } from '../util/json-file';

export type StoredConfig = {
  platformUrl: string | null;
  token: string | null;
  session: Session | null;
  lastOkAt: string | null;
};

export type Notice = {
  at: string;
  moduleKey: string | null;
  title: string | null;
  reason: string;
};

type StoredState = { notices: Notice[] };

export type CurrentTask = {
  labId: string;
  attemptId: string;
  label: string;
  title: string;
  promptMd: string;
  input?: 'none' | 'bug-report' | 'answer-field';
  modules: Array<{ key: string; title: string }>;
  probes: Array<{ id: string; probe: string; params: Record<string, unknown> }>;
  seeded: boolean;
};

type StoredTask = { current: CurrentTask | null };

const EMPTY_CONFIG: StoredConfig = { platformUrl: null, token: null, session: null, lastOkAt: null };
const EMPTY_STATE: StoredState = { notices: [] };

const configPath = (dataDir: string) => join(dataDir, 'config.json');
const statePath = (dataDir: string) => join(dataDir, 'state.json');
const taskPath = (dataDir: string) => join(dataDir, 'task.json');

export function readConfig(dataDir: string): StoredConfig {
  return readJson(configPath(dataDir), EMPTY_CONFIG);
}

export function writeConfig(dataDir: string, patch: Partial<StoredConfig>): StoredConfig {
  const next = { ...readConfig(dataDir), ...patch };
  writeJson(configPath(dataDir), next);
  return next;
}

export function clearConfig(dataDir: string): void {
  writeJson(configPath(dataDir), EMPTY_CONFIG);
}

export function readNotices(dataDir: string): Notice[] {
  return readJson(statePath(dataDir), EMPTY_STATE).notices;
}

export function appendNotices(dataDir: string, added: Notice[]): void {
  if (!added.length) return;
  writeJson(statePath(dataDir), { notices: [...readNotices(dataDir), ...added].slice(-50) });
}

export function takeNotices(dataDir: string): Notice[] {
  const notices = readNotices(dataDir);
  if (notices.length) writeJson(statePath(dataDir), EMPTY_STATE);
  return notices;
}

export function readCurrentTask(dataDir: string): CurrentTask | null {
  return readJson<StoredTask>(taskPath(dataDir), { current: null }).current;
}

export function writeCurrentTask(dataDir: string, current: CurrentTask | null): void {
  writeJson(taskPath(dataDir), { current });
}

const bankSecretPath = (dataDir: string) => join(dataDir, 'bank-secret');

export function readBankSecret(dataDir: string): string | null {
  try {
    const value = readFileSync(bankSecretPath(dataDir), 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export function ensureBankSecret(dataDir: string): string {
  const existing = readBankSecret(dataDir);
  if (existing) return existing;
  const secret = randomBytes(24).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(bankSecretPath(dataDir), `${secret}\n`, { mode: 0o600 });
  return secret;
}
