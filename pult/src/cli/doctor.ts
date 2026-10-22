import type { Runtime } from '../config';
import { dockerInfo } from '../docker/kit-docker';
import { fetchPrimitiveKeys, fetchSession, pingPlatform } from '../platform/client';
import { supportedPrimitives } from '../platform/primitives';
import { readConfig } from '../store/stores';
import { compareVersions, UPDATE_HINT } from '../util/version';
import { color, line } from '../util/out';
import { formatShortDate } from './format';

type Verdict = 'ok' | 'warn' | 'fail';

const LISTED = 5;

export function comparePrimitives(local: string[], remote: string[]): { verdict: Verdict; text: string } {
  const missing = remote.filter((key) => !local.includes(key));
  if (missing.length) {
    return {
      verdict: 'warn',
      text: `Платформа знает проверки, которых нет в пульте (${missing.slice(0, LISTED).join(', ')}${missing.length > LISTED ? '…' : ''}). ${UPDATE_HINT}`,
    };
  }
  const extra = local.filter((key) => !remote.includes(key));
  return {
    verdict: 'ok',
    text: extra.length
      ? `Список проверок пульта (${local.length}) шире, чем у платформы — лишнее не мешает`
      : `Список проверок пульта совпадает с платформой (${local.length})`,
  };
}

const MIN_DOCKER_MEMORY_MB = 7168;

function report(verdict: Verdict, text: string): void {
  const mark = verdict === 'ok' ? color.green('✓') : verdict === 'warn' ? color.yellow('!') : color.red('✗');
  line(`  ${mark} ${text}`);
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export async function runDoctor(runtime: Runtime): Promise<number> {
  let failures = 0;
  const note = (verdict: Verdict, text: string) => {
    if (verdict === 'fail') failures += 1;
    report(verdict, text);
  };

  const info = await dockerInfo();
  if (info.ok) {
    note('ok', `Docker запущен (версия ${info.serverVersion})`);
    const gb = (info.memTotalMb / 1024).toFixed(1).replace('.', ',');
    note(
      info.memTotalMb >= MIN_DOCKER_MEMORY_MB ? 'ok' : 'warn',
      info.memTotalMb >= MIN_DOCKER_MEMORY_MB
        ? `Docker отдано ${gb} ГБ памяти`
        : `Docker отдано ${gb} ГБ памяти — для набора нужно 8 ГБ, прибавьте в настройках Docker`,
    );
  } else {
    note('fail', 'Docker не отвечает — запустите Docker Desktop и дождитесь статуса Running');
  }

  const hub = await reachable('https://registry-1.docker.io/v2/');
  const ghcr = await reachable('https://ghcr.io/v2/');
  note(hub && ghcr ? 'ok' : 'warn', `Реестры образов: Docker Hub ${hub ? 'доступен' : 'не отвечает'}, ghcr.io ${ghcr ? 'доступен' : 'не отвечает'}`);

  const ping = await pingPlatform(runtime.platformUrl);
  note(
    ping.ok ? 'ok' : 'fail',
    ping.ok ? `Платформа доступна (${runtime.platformUrl})` : `Платформа не отвечает (${runtime.platformUrl}): ${ping.reason}`,
  );

  const config = readConfig(runtime.dataDir);
  if (!config.token) {
    note('fail', 'Токен не задан — выполните ./stand login');
  } else {
    const result = await fetchSession(config.platformUrl ?? runtime.platformUrl, config.token, runtime.version);
    const remoteKeys = result.ok
      ? await fetchPrimitiveKeys({
          platformUrl: config.platformUrl ?? runtime.platformUrl,
          token: config.token,
          kitVersion: runtime.version,
        })
      : null;
    if (result.ok) {
      note('ok', `Токен действует до ${formatShortDate(result.session.token.expiresAt)}`);
      const { minVersion, latestVersion } = result.session.kit;
      if (compareVersions(runtime.version, minVersion) < 0) {
        note('fail', `Набор ${runtime.version} устарел, нужна не ниже ${minVersion}. ${UPDATE_HINT}`);
      } else if (compareVersions(runtime.version, latestVersion) < 0) {
        note('warn', `Набор ${runtime.version}, вышла ${latestVersion}. ${UPDATE_HINT}`);
      } else {
        note('ok', `Набор ${runtime.version} — актуальная версия`);
      }
      if (remoteKeys?.ok) {
        const verdict = comparePrimitives(await supportedPrimitives(), remoteKeys.value);
        note(verdict.verdict, verdict.text);
      } else if (remoteKeys) {
        note('warn', `Не удалось сверить список проверок: ${remoteKeys.message}`);
      }
    } else {
      note('fail', result.message);
    }
  }
  return failures ? 1 : 0;
}
