import { runAgent } from '../agent/run';
import type { Runtime } from '../config';
import { listKitContainers, memoryTotalMb } from '../docker/kit-docker';
import { versionGate, versionReminder } from '../modules/lifecycle';
import { dispatchAction } from '../actions/dispatcher';
import { buildRows, findModule } from '../modules/view';
import type { Session, SessionModule } from '../platform/types';
import { readNotices } from '../store/stores';
import { routeNotices } from '../panel/gateway';
import { color, errorLine, line } from '../util/out';
import { runDoctor } from './doctor';
import { formatShortDate } from './format';
import { askYesNo, isInteractive, offerStopIdle } from './idle';
import { runMenu } from './menu/run';
import { renderRows } from './menu/render';
import { consoleProgress } from './progress';
import { loadSession, login, type SessionContext } from './session';
import { startProjectFlow } from './start';
import { taskConfirmation } from './tasks';
import { belowMinimum, needsReconcile, NO_NEW_VERSION, refusalReason, UPDATE_EXIT_CODE, UpdateOffers } from './update';
import { reconcileAfterUpdate, runUpdateOffer } from './update-flow';

export { UPDATE_EXIT_CODE } from './update';

const offers = new UpdateOffers();
const LAUNCH_COMMANDS = new Set(['start', 'check']);
const GUARDED_COMMANDS = new Set(['up', 'restart', 'task', 'verify']);

const USAGE = `Команды набора:
  ./stand                 поднять учебный проект и открыть меню
  ./stand start           поднять учебный проект: стенды и текущий тикет
  ./stand login           подключить пульт к аккаунту по коду на сайте
  ./stand login --token   вставить токен с платформы вручную
  ./stand logout          забыть токен на этом компьютере
  ./stand status          состояние стендов
  ./stand up <стенд…>     запустить стенды (kit-rabbitmq или rabbitmq)
  ./stand down [стенд…]   остановить стенды, без имён — все
  ./stand restart <стенд…> перезапустить стенды (остановить и запустить)
  ./stand reset <стенд>   удалить контейнеры и данные стенда
  ./stand tasks           список задач
  ./stand task start <номер>  начать задачу: запустить стенды, подготовить, показать условие
  ./stand task restart [--yes] начать текущую задачу заново: сценарий применяется снова, файлы в work/ не меняются
  ./stand task            показать условие текущей задачи ещё раз
  ./stand check           проверить текущую задачу
  ./stand verify <задача> проверить задачу эталоном (только администратор)
  ./stand doctor          проверить Docker, память, сеть, платформу и токен
  ./stand agent           фоновая проверка токена (запускается сама)`;

async function printNotices(runtime: Runtime, consume: boolean): Promise<void> {
  const notices = consume ? await routeNotices(runtime) : readNotices(runtime.dataDir);
  for (const notice of notices) {
    line(color.yellow(`! ${notice.title ?? 'Стенд'} остановлен: ${notice.reason}`));
  }
}

function resolveModules(session: Session, names: string[]): SessionModule[] | null {
  const found: SessionModule[] = [];
  for (const name of names) {
    const module = findModule(session, name);
    if (!module) {
      errorLine(`Нет такого стенда: ${name}. Доступные: ${session.modules.map((m) => m.key).join(', ')}`);
      return null;
    }
    found.push(module);
  }
  return found;
}

async function printStatus(runtime: Runtime, ctx: SessionContext): Promise<void> {
  const containers = await listKitContainers();
  const rows = buildRows(ctx.session, containers, await memoryTotalMb(runtime));
  line(`${color.bold('Запускай · стенды')}  пульт ${runtime.version}`);
  line(`${ctx.session.user.name} · токен действует до ${formatShortDate(ctx.session.token.expiresAt)}`);
  const reminder = versionReminder(runtime, ctx.session);
  if (reminder) line(color.yellow(reminder));
  line();
  for (const text of renderRows(rows, null)) line(text);
}

async function commandUp(runtime: Runtime, ctx: SessionContext, names: string[]): Promise<number> {
  if (!names.length) {
    errorLine('Укажите стенды: ./stand up kit-rabbitmq kit-kafka');
    return 1;
  }
  const gate = versionGate(runtime, ctx.session);
  if (gate) {
    errorLine(gate);
    return 1;
  }
  const modules = resolveModules(ctx.session, names);
  if (!modules) return 1;
  await offerStopIdle({
    session: ctx.session,
    starting: modules,
    containers: await listKitContainers(),
    interactive: isInteractive(),
    ask: askYesNo,
    stop: async (idle) => (await dispatchAction({ runtime, session: ctx.session, stale: ctx.stale, progress: consoleProgress }, { action: 'module.stop', moduleKey: idle.key })).ok,
  });
  let failed = 0;
  for (const module of modules) {
    if (!(await dispatchAction({ runtime, session: ctx.session, stale: ctx.stale, progress: consoleProgress }, { action: 'module.start', moduleKey: module.key })).ok) failed += 1;
  }
  return failed ? 1 : 0;
}

async function commandDown(runtime: Runtime, ctx: SessionContext, names: string[]): Promise<number> {
  const actionContext = { runtime, session: ctx.session, stale: ctx.stale, progress: consoleProgress };
  if (!names.length) return (await dispatchAction(actionContext, { action: 'modules.stopAll' })).ok ? 0 : 1;
  const modules = resolveModules(ctx.session, names);
  if (!modules) return 1;
  let failed = false;
  for (const module of modules) if (!(await dispatchAction(actionContext, { action: 'module.stop', moduleKey: module.key })).ok) failed = true;
  return failed ? 1 : 0;
}

async function commandReset(runtime: Runtime, ctx: SessionContext, args: string[]): Promise<number> {
  const names = args.filter((arg) => arg !== '--yes');
  if (names.length !== 1) { errorLine('Укажите один стенд: ./stand reset kit-postgres'); return 1; }
  const module = resolveModules(ctx.session, names)?.[0];
  if (!module) return 1;
  const result = await dispatchAction({ runtime, session: ctx.session, stale: ctx.stale, progress: consoleProgress,
    confirmed: args.includes('--yes'), ask: taskConfirmation }, { action: 'module.reset', moduleKey: module.key });
  if (!result.ok && result.code === 'CONFIRMATION_REQUIRED') errorLine('Сброс отменён. Без терминала подтвердите явно: --yes');
  return result.ok ? 0 : 1;
}

async function runTaskCommand(
  runtime: Runtime,
  ctx: SessionContext,
  command: string,
  args: string[],
): Promise<number> {
  const tasks = await import('./tasks.js');
  if (ctx.stale && (command === 'check' || command === 'verify' || (command === 'task' && ['start', 'restart'].includes(args[0] ?? '')))) {
    errorLine('Для подготовки и проверки задачи нужна связь с платформой');
    return 1;
  }
  if (command === 'tasks') {
    tasks.printTaskList(ctx.session);
    return 0;
  }
  if (command === 'task' && args[0] === 'restart') return (await tasks.restartTaskFlow(runtime, ctx.session, consoleProgress, { yes: args.includes('--yes') })) ? 0 : 1;
  if (command === 'task' && args[0] !== 'start') return tasks.showCurrentTask(runtime);
  if (command === 'task') {
    if (!args[1]) {
      errorLine('Укажите задачу: ./stand task start 1');
      return 1;
    }
    return (await tasks.startTaskFlow(runtime, ctx.session, args.slice(1).join(' '), consoleProgress)) ? 0 : 1;
  }
  if (command === 'check') {
    const outcome = await tasks.checkFlow(runtime, consoleProgress, ctx.session);
    return outcome && outcome.status === 'PASSED' ? 0 : 1;
  }
  const labId = args.find((arg) => !arg.startsWith('--'));
  if (!labId) {
    errorLine('Укажите задачу: ./stand verify <идентификатор задачи>');
    return 1;
  }
  const options = { yes: args.includes('--yes'), reset: !args.includes('--no-reset') };
  return (await tasks.verifyFlow(runtime, ctx.session, labId, options, consoleProgress)) ? 0 : 1;
}

export async function runCli(runtime: Runtime, argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (command === 'help' || command === '--help' || command === '-h') {
    line(USAGE);
    return 0;
  }
  if (command === 'login') return (await login(runtime, { paste: args.includes('--token') })) ? 0 : 1;
  if (command === 'logout') {
    const result = await dispatchAction({ runtime, progress: consoleProgress, confirmed: true }, { action: 'platform.logout' });
    if (!result.ok) return 1;
    line('Токен удалён с этого компьютера. Запущенные стенды продолжают работать: ./stand down');
    return 0;
  }
  if (command === 'down' && !args.length) return (await dispatchAction({ runtime, progress: consoleProgress }, { action: 'modules.stopAll' })).ok ? 0 : 1;
  if (command === 'doctor') return runDoctor(runtime);
  if (command === 'agent') return runAgent(runtime);
  if (command && !['start', 'status', 'up', 'down', 'restart', 'reset', 'tasks', 'task', 'check', 'verify'].includes(command)) {
    errorLine(`Неизвестная команда: ${command}\n\n${USAGE}`);
    return 1;
  }

  await printNotices(runtime, Boolean(command));
  const ctx = await loadSession(runtime, interactive);
  if (!ctx) return 1;
  const askForUpdate = !command || LAUNCH_COMMANDS.has(command) || (GUARDED_COMMANDS.has(command) && belowMinimum(runtime, ctx.session));
  if (process.env.STAND_UPDATED) {
    offers.suppressed = true;
    if (askForUpdate && process.env.STAND_UPDATED === 'nonew') line(NO_NEW_VERSION);
  }
  if (askForUpdate && !offers.suppressed) {
    const outcome = await runUpdateOffer({ runtime, ctx, offers, atLaunch: true, progress: consoleProgress, say: line });
    if (outcome === 'updating') return UPDATE_EXIT_CODE;
  }
  if (askForUpdate && belowMinimum(runtime, ctx.session) && !ctx.stale) {
    errorLine(refusalReason(runtime, ctx.session));
    return 1;
  }
  if (command !== 'start' && command !== undefined && needsReconcile(command)) await reconcileAfterUpdate(runtime, ctx.session, consoleProgress);
  if (command === 'start') {
    const outcome = await startProjectFlow(runtime, ctx.session, consoleProgress, ctx.stale);
    if (!outcome.hasProject) line('Учебного проекта пока нет: стенды запускаются через меню ./stand.');
    if (outcome.code === 0) await reconcileAfterUpdate(runtime, ctx.session, consoleProgress);
    return outcome.code;
  }
  if (!command) {
    if (!interactive) {
      await printStatus(runtime, ctx);
      return 0;
    }
    const outcome = await startProjectFlow(runtime, ctx.session, consoleProgress, ctx.stale);
    if (outcome.hasProject) line();
    if (outcome.code === 0) await reconcileAfterUpdate(runtime, ctx.session, consoleProgress);
    return (await runMenu(runtime, ctx, offers)) === 'update' ? UPDATE_EXIT_CODE : 0;
  }
  if (command === 'status') {
    await printStatus(runtime, ctx);
    return 0;
  }
  if (command === 'up') return commandUp(runtime, ctx, args);
  if (command === 'down') return commandDown(runtime, ctx, args);
  if (command === 'restart') {
    if (!args.length) {
      errorLine('Укажите стенды: ./stand restart kit-bank');
      return 1;
    }
    const modules = resolveModules(ctx.session, args);
    if (!modules) return 1;
    let failed = false;
    for (const module of modules) if (!(await dispatchAction({ runtime, session: ctx.session, stale: ctx.stale, progress: consoleProgress },
      { action: 'module.restart', moduleKey: module.key })).ok) failed = true;
    return failed ? 1 : 0;
  }
  if (command === 'reset') return commandReset(runtime, ctx, args);
  return runTaskCommand(runtime, ctx, command!, args);
}
