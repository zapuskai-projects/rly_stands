import { emitKeypressEvents } from 'node:readline';
import type { Runtime } from '../../config';
import { listKitContainers, memoryTotalMb, profileState } from '../../docker/kit-docker';
import { startModule, stopModule, versionReminder } from '../../modules/lifecycle';
import { buildRows, type ModuleRow } from '../../modules/view';
import { fetchSession } from '../../platform/client';
import { supportedPrimitives } from '../../platform/primitives';
import { readConfig, readCurrentTask, takeNotices, writeConfig } from '../../store/stores';
import { color, screen, line, write } from '../../util/out';
import { formatShortDate } from '../format';
import { collectingProgress } from '../progress';
import type { SessionContext } from '../session';
import { checkFlow, startTaskFlow } from '../tasks';
import { keyAction, type Key } from './keys';
import { renderMenu, type MenuMode } from './render';

const POLL_MS = 4000;
const SESSION_REFRESH_MS = 60_000;

export async function runMenu(runtime: Runtime, initial: SessionContext): Promise<void> {
  let ctx = initial;
  let rows: ModuleRow[] = [];
  let mode: MenuMode = 'modules';
  let selected = 0;
  const primitives = await supportedPrimitives();
  let message: string | null = null;
  let busy = false;
  let lastSessionAt = Date.now();
  const notices = takeNotices(runtime.dataDir).map(
    (notice) => `${notice.title ?? 'Стенд'} остановлен: ${notice.reason}`,
  );

  const listLength = () => (mode === 'tasks' ? ctx.session.tasks.length : rows.length);

  const refreshRows = async () => {
    const containers = await listKitContainers();
    rows = buildRows(ctx.session, containers, await memoryTotalMb(runtime));
    selected = Math.min(selected, Math.max(0, listLength() - 1));
  };

  const draw = () => {
    screen.clear();
    for (const text of renderMenu({
      mode,
      tasks: ctx.session.tasks,
      currentTask: readCurrentTask(runtime.dataDir)?.title ?? null,
      version: runtime.version,
      userName: ctx.session.user.name,
      tokenUntil: formatShortDate(ctx.session.token.expiresAt),
      rows,
      selected,
      reminder: versionReminder(runtime, ctx.session),
      notices,
      message,
      stale: ctx.stale,
    })) {
      line(text);
    }
  };

  const refreshSession = async (): Promise<boolean> => {
    const config = readConfig(runtime.dataDir);
    if (!config.token) return false;
    const result = await fetchSession(
      config.platformUrl ?? runtime.platformUrl,
      config.token,
      runtime.version,
      primitives,
    );
    lastSessionAt = Date.now();
    if (result.ok) {
      ctx = { session: result.session, stale: false, staleSince: null };
      writeConfig(runtime.dataDir, { session: result.session, lastOkAt: new Date().toISOString() });
      return true;
    }
    if (result.kind === 'rejected') {
      writeConfig(runtime.dataDir, { token: null });
      message = result.message;
      return false;
    }
    ctx = { ...ctx, stale: true };
    return true;
  };

  const toggle = async (): Promise<boolean> => {
    const row = rows[selected];
    if (!row) return true;
    const alive = await refreshSession();
    if (!alive) return false;
    const module = ctx.session.modules.find((item) => item.key === row.key);
    if (!module) return true;
    const containers = await listKitContainers();
    screen.clear();
    const { progress, summary } = collectingProgress();
    const state = profileState(containers, module.profile);
    if (state === 'stopped') await startModule(runtime, ctx.session, module, progress);
    else await stopModule(module, progress);
    message = summary();
    await refreshRows();
    return true;
  };

  const stopAll = async (): Promise<boolean> => {
    const containers = await listKitContainers();
    const running = ctx.session.modules.filter((item) => profileState(containers, item.profile) !== 'stopped');
    screen.clear();
    const { progress, summary } = collectingProgress();
    if (!running.length) progress.info('Все стенды уже остановлены');
    for (const module of running) await stopModule(module, progress);
    message = summary();
    await refreshRows();
    return true;
  };

  /** Остановить и запустить заново: помогает, когда стенд завис или запущен не полностью. */
  const restart = async (): Promise<boolean> => {
    const row = rows[selected];
    if (!row) return true;
    if (!(await refreshSession())) return false;
    const module = ctx.session.modules.find((item) => item.key === row.key);
    if (!module) return true;
    screen.clear();
    const { progress, summary } = collectingProgress();
    if (profileState(await listKitContainers(), module.profile) !== 'stopped') await stopModule(module, progress);
    await startModule(runtime, ctx.session, module, progress);
    message = summary();
    await refreshRows();
    return true;
  };

  const waitKey = () =>
    new Promise<void>((resolve) => {
      const handler = () => {
        process.stdin.off('keypress', handler);
        resolve();
      };
      line();
      line(color.dim('Нажмите любую клавишу, чтобы вернуться в меню'));
      process.stdin.on('keypress', handler);
    });

  const startSelectedTask = async (): Promise<boolean> => {
    const task = ctx.session.tasks[selected];
    if (!task) return true;
    if (!(await refreshSession())) return false;
    screen.clear();
    const { progress, summary } = collectingProgress();
    await startTaskFlow(runtime, ctx.session, task.id, progress);
    message = summary();
    await waitKey();
    await refreshSession();
    await refreshRows();
    return true;
  };

  const checkCurrent = async (): Promise<boolean> => {
    if (!(await refreshSession())) return false;
    screen.clear();
    const { progress, summary } = collectingProgress();
    const outcome = await checkFlow(runtime, progress);
    message = outcome ? outcome.result.message : summary();
    await waitKey();
    await refreshSession();
    await refreshRows();
    return true;
  };

  await refreshRows();
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearInterval(timer);
      process.stdin.off('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      screen.showCursor();
      write('\n');
      resolve();
    };

    const onKey = async (_chunk: string, key: Key) => {
      if (busy) return;
      const action = keyAction(key);
      if (action === 'interrupt') {
        finish();
        return;
      }
      if (action === 'back' && mode === 'tasks') {
        mode = 'modules';
        selected = 0;
      } else if (action === 'back') {
        finish();
        return;
      } else if (action === 'tasks') {
        mode = mode === 'tasks' ? 'modules' : 'tasks';
        selected = 0;
      } else if (action === 'check') {
        busy = true;
        const alive = await checkCurrent();
        busy = false;
        if (!alive) {
          draw();
          finish();
          return;
        }
      } else if ((action === 'stopAll' || action === 'restart') && mode === 'modules') {
        busy = true;
        const alive = action === 'stopAll' ? await stopAll() : await restart();
        busy = false;
        if (!alive) {
          draw();
          finish();
          return;
        }
      } else if (action === 'up' && listLength()) selected = (selected - 1 + listLength()) % listLength();
      else if (action === 'down' && listLength()) selected = (selected + 1) % listLength();
      else if (action === 'enter') {
        busy = true;
        const alive = mode === 'tasks' ? await startSelectedTask() : await toggle();
        busy = false;
        if (!alive) {
          draw();
          finish();
          return;
        }
      } else return;
      draw();
    };

    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      if (Date.now() - lastSessionAt > SESSION_REFRESH_MS) await refreshSession();
      await refreshRows();
      busy = false;
      draw();
    }, POLL_MS);

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('keypress', onKey);
    screen.hideCursor();
    draw();
  });
}
