import type { Runtime } from '../config';
import { hasImage, pullImage } from '../docker/kit-docker';
import type { Progress } from '../modules/lifecycle';
import { pullTracker } from '../modules/pull';
import { imagesToPull, type StaleService } from '../modules/reconcile';
import type { Session } from '../platform/types';
import { compareVersions } from '../util/version';
import type { SessionContext } from './session';

export const UPDATE_EXIT_CODE = 75;

const REASK_MS = 60 * 60 * 1000;
const PULT_IMAGE_REPOSITORY = 'ghcr.io/zapuskai-projects/stands-kit-pult';

export function belowMinimum(runtime: Runtime, session: Session): boolean {
  return compareVersions(runtime.version, session.kit.minVersion) < 0;
}

/** Версия, на которую предлагаем обновиться: новее нашей; ниже минимальной — предлагаем всегда. */
export function newerVersion(runtime: Runtime, ctx: SessionContext): string | null {
  if (ctx.stale) return null;
  const { latestVersion, minVersion } = ctx.session.kit;
  if (belowMinimum(runtime, ctx.session)) return compareVersions(latestVersion, minVersion) >= 0 ? latestVersion : minVersion;
  return compareVersions(runtime.version, latestVersion) < 0 ? latestVersion : null;
}

export const NO_NEW_VERSION = 'В репозитории набора новой версии ещё нет — обновление появится позже.';

const RECONCILE_COMMANDS = new Set(['start', 'up', 'restart', 'task', 'check', 'verify']);

/** Перед этими командами догоняем контейнеры после согласованного обновления; down, reset и status стенды не меняют. */
export const needsReconcile = (command: string | undefined): boolean => !command || RECONCILE_COMMANDS.has(command);

export const withUpdateNote = (note: string | null, text: string): string => [note, text].filter(Boolean).join('\n ');

export const updateMenuLine = (version: string): string => `Вышла версия ${version}. Обновить — клавиша У.`;
export const updatePlainLine = (version: string): string => `Вышла версия ${version}, обновить: ./stand`;
export const updateQuestion = (version: string): string => `Вышла версия ${version}. Обновить сейчас? Стенды и ваши файлы останутся. [Д/н]`;

export function refusalReason(runtime: Runtime, session: Session): string {
  return `Версия набора ${runtime.version} устарела, нужна не ниже ${session.kit.minVersion}. Без обновления работать нельзя: запустите ./stand и согласитесь обновиться.`;
}

export class UpdateOffers {
  private declinedAt: number | null = null;
  suppressed = false;

  canAsk(now: number): boolean {
    return this.declinedAt === null || now - this.declinedAt >= REASK_MS;
  }

  decline(now: number): void {
    this.declinedAt = now;
  }
}

export type PrepareDeps = {
  pultImage: string | null;
  stale: () => Promise<StaleService[] | null>;
  hasImage: (image: string) => Promise<boolean>;
  pull: (image: string, onLine: (line: string) => void) => Promise<number>;
  remember: (version: string, profiles: string[]) => void;
};

export function pultImageFor(version: string, env: NodeJS.ProcessEnv = process.env): string | null {
  return env.STAND_PULT_IMAGE ? null : `${PULT_IMAGE_REPOSITORY}:${version}`;
}

export function defaultPrepareDeps(
  version: string,
  stale: () => Promise<StaleService[] | null>,
  remember: (version: string, profiles: string[]) => void,
): PrepareDeps {
  return { pultImage: pultImageFor(version), stale, hasImage, pull: pullImage, remember };
}

/** Скачивает всё нужное для новой версии, пока стенды работают; запоминает согласие только после успеха. */
export async function prepareUpdate(version: string, current: string, progress: Progress, deps: PrepareDeps): Promise<boolean> {
  const own = (await deps.stale()) ?? [];
  const images = [...(deps.pultImage ? [deps.pultImage] : []), ...imagesToPull(own)];
  for (const image of [...new Set(images)]) {
    if (await deps.hasImage(image)) continue;
    progress.info(`Скачиваю ${image}`);
    const code = await deps.pull(image, pullTracker((text) => progress.info(text)));
    if (code !== 0) {
      progress.fail(`Версия ${version} не скачалась: она ещё собирается (около 15 минут после выпуска) или нет интернета. Остаюсь на версии ${current}, стенды работают.`);
      return false;
    }
  }
  deps.remember(version, [...new Set(own.map((item) => item.running.profile).filter(Boolean))]);
  progress.ok(`Версия ${version} скачана, перезапускаю пульт`);
  return true;
}

export type OfferOutcome = 'none' | 'plain' | 'later' | 'updating' | 'declined' | 'failed';

export type OfferDeps = {
  runtime: Runtime;
  ctx: SessionContext;
  interactive: boolean;
  offers: UpdateOffers;
  atLaunch: boolean;
  ask: (question: string) => Promise<boolean>;
  prepare: (version: string) => Promise<boolean>;
  say: (text: string) => void;
  now?: () => number;
};

/** Предложение обновиться: без терминала только строка; отказ запоминается на час, при запуске спрашиваем всегда. */
export async function offerUpdate(deps: OfferDeps): Promise<OfferOutcome> {
  if (deps.offers.suppressed) return 'none';
  const version = newerVersion(deps.runtime, deps.ctx);
  if (!version) return 'none';
  if (!deps.interactive) {
    deps.say(updatePlainLine(version));
    return 'plain';
  }
  const now = (deps.now ?? Date.now)();
  if (!deps.atLaunch && !deps.offers.canAsk(now)) return 'later';
  if (!(await deps.ask(updateQuestion(version)))) {
    deps.offers.decline(now);
    return 'declined';
  }
  return (await deps.prepare(version)) ? 'updating' : 'failed';
}
