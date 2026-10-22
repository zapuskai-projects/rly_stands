import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe } from 'node:test';
import { waitReady, type ReadyCheck } from '../../modules/readiness';
import { EXECUTORS } from '../../probes/registry';
import type { ProbeContext } from '../../probes/types';

export type LiveEnv = {
  probe: <T = Record<string, unknown>>(key: string, params: Record<string, unknown>) => Promise<T>;
  write: (relative: string, content: string) => void;
  dataDir: () => string;
  workDir: () => string;
  label: string;
  context: () => ProbeContext;
};

const LABEL = 'live01';
const READY_FAILED = 'модуль не поднялся';

function enabledGroups(): Set<string> {
  return new Set(
    (process.env.KIT_LIVE ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

export function liveSuite(group: string, ready: ReadyCheck[], title: string, body: (env: LiveEnv) => void): void {
  const groups = enabledGroups();
  const on = groups.has(group) || groups.has('all');
  describe(title, { skip: on ? false : `нужен KIT_LIVE=${group}` }, () => {
    let work = '';
    let data = '';

    before(async () => {
      work = mkdtempSync(join(tmpdir(), 'kit-live-work-'));
      data = mkdtempSync(join(tmpdir(), 'kit-live-data-'));
      const reports = await waitReady(ready, work, () => undefined);
      const failed = reports.find((report) => !report.ok);
      if (failed) throw new Error(`${failed.label}: ${READY_FAILED}`);
    });

    after(() => {
      rmSync(work, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    });

    const context = (): ProbeContext => ({ workDir: work, dataDir: data, label: LABEL });

    body({
      label: LABEL,
      context,
      workDir: () => work,
      dataDir: () => data,
      write: (relative, content) => {
        const target = join(work, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, 'utf8');
      },
      probe: async <T>(key: string, params: Record<string, unknown>) => {
        const executor = EXECUTORS[key];
        if (!executor) throw new Error(`нет исполнителя ${key}`);
        return (await executor(params, context())) as T;
      },
    });
  });
}

export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
  stepMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    value = await read();
  }
  return value;
}
