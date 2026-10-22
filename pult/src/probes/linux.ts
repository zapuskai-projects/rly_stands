import { run } from '../docker/exec';
import { ProbeError } from './errors';
import { http } from './http';
import { executor, sleep, type ExecutorTable } from './types';

const CONTAINER = 'stands-kit-linux-server';
const SERVER = 'http://linux-server';
const SCENARIOS_DIR = '/opt/scenarios';
const BODY_START = 200;
const STARTING_WAIT_ATTEMPTS = 6;

async function inContainer(command: string[], user = 'root') {
  const result = await run('docker', ['exec', '-u', user, CONTAINER, ...command], { timeoutMs: 30_000 });
  if (result.code !== 0 && /No such container|is not running/i.test(result.stderr)) {
    throw new ProbeError('Linux-сервер не запущен');
  }
  return result;
}

export function parseServices(output: string): Array<{ name: string; state: string }> {
  return output
    .split('\n')
    .map((row) => /^(\S+)\s+([A-Z]+)\b/.exec(row.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ name: match[1]!, state: match[2]! }));
}

export function parseStat(output: string) {
  const [mode = '', owner = '', group = '', size = '0'] = output.trim().split('|');
  return { exists: true, mode, owner, group, size: Number(size) || 0 };
}

export function parseDiskPercent(output: string): number | null {
  const last = output.trim().split('\n').at(-1) ?? '';
  const match = /(\d+)%/.exec(last);
  return match ? Number(match[1]) : null;
}

export const LINUX_EXECUTORS: ExecutorTable = {
  'linux.services': executor<Record<string, never>>(async () => {
    let services = parseServices((await inContainer(['supervisorctl', 'status'])).stdout);
    for (let attempt = 0; attempt < STARTING_WAIT_ATTEMPTS && services.some((item) => item.state === 'STARTING'); attempt += 1) {
      await sleep(1000);
      services = parseServices((await inContainer(['supervisorctl', 'status'])).stdout);
    }
    return { services };
  }),

  'linux.file': executor<{ path: string }>(async ({ path }) => {
    const result = await inContainer(['stat', '-c', '%a|%U|%G|%s', path]);
    if (result.code !== 0) return { exists: false, mode: '', owner: '', group: '', size: 0 };
    return parseStat(result.stdout);
  }),

  'linux.disk': executor<{ mount: string }>(async ({ mount }) => {
    const result = await inContainer(['df', '-P', mount]);
    return { mount, usedPercent: result.code === 0 ? parseDiskPercent(result.stdout) : null };
  }),

  'linux.port': executor<{ port: number }>(async ({ port }) => {
    const result = await inContainer(['ss', '-ltn']);
    const listening = result.stdout.split('\n').some((row) => new RegExp(`[:.]${port}\\s`).test(row));
    return { port, listening };
  }),

  'linux.http': executor<{ path: string; method?: string; body?: string }>(async ({ path, method, body }) => {
    const result = await http('Linux-сервер', `${SERVER}${path.startsWith('/') ? path : `/${path}`}`, {
      method: method ?? 'GET',
      body,
      timeoutMs: 10_000,
    });
    return { status: result.status, bodyStart: result.text.slice(0, BODY_START) };
  }),

  'linux.scenario': executor<{ name: string }>(async ({ name }, ctx) => {
    const result = await inContainer([`${SCENARIOS_DIR}/${name}/apply.sh`, ctx.label]);
    if (result.code !== 0) throw new ProbeError(`Сценарий ${name} не применился: ${result.stderr.trim().slice(0, 200)}`);
    return { applied: true };
  }),

  'linux.exec': executor<{ script: string }>(async ({ script }) => {
    const result = await inContainer([`${SCENARIOS_DIR}/${script}`]);
    if (result.code !== 0) throw new ProbeError(`Исправление ${script} не выполнено: ${result.stderr.trim().slice(0, 200)}`);
    return { executed: true };
  }),
};
