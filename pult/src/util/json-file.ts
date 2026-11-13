import { readFileSync } from 'node:fs';
import { durableJson } from '../panel/durable';

export function readJson<T>(path: string, fallback: T): T {
  try {
    return { ...fallback, ...(JSON.parse(readFileSync(path, 'utf8')) as object) } as T;
  } catch {
    return fallback;
  }
}

export function writeJson(path: string, value: unknown): void {
  durableJson(path, value);
}
