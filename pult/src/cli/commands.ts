import { confirm } from '@inquirer/prompts';
import { runAgent } from '../agent/run';
import type { Runtime } from '../config';
import { listKitContainers, memoryTotalMb, profileState } from '../docker/kit-docker';
import { resetModule, startModule, stopModule, versionGate, versionReminder } from '../modules/lifecycle';
import { buildRows, findModule } from '../modules/view';
import type { Session, SessionModule } from '../platform/types';
import { clearConfig, readNotices, takeNotices } from '../store/stores';
import { color, errorLine, line } from '../util/out';
import { compareVersions } from '../util/version';
import { runDoctor } from './doctor';
import { formatShortDate } from './format';
import { askYesNo, isInteractive, offerStopIdle } from './idle';
import { runMenu } from './menu/run';
import { renderRows } from './menu/render';
import { consoleProgress } from './progress';
import { loadSession, login, type SessionContext } from './session';
import { startProjectFlow } from './start';

/** Код выхода «обновите набор»: скрипт ./stand делает git pull и запускает пульт заново. */
export const UPDATE_EXIT_CODE = 75;

export function shouldSelfUpdate(runtime: Runtime, ctx: SessionContext, env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.STAND_SELF_UPDATE === '1' &&
    env.STAND_UPDATED !== '1' &&
    !ctx.stale &&
    compareVersions(runtime.version, ctx.session.kit.latestVersion) < 0
  );
}

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
  ./stand task            показать условие текущей задачи ещё раз
  ./stand check           проверить текущую задачу
  ./stand verify <задача> проверить задачу эталоном (только администратор)
  ./stand doctor          проверить Docker, память, сеть, платформу и токен
  ./stand agent           фоновая проверка токена (запускается сама)`;

function printNotices(runtime: Runtime, consume: boolean): void {
  const notices = consume ? takeNotices(runtime.dataDir) : readNotices(runtime.dataDir);
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
    stop: (idle) => stopModule(idle, consoleProgress),
  });
  let failed = 0;
  for (const module of modules) {
    if (!(await startModule(runtime, ctx.session, module, consoleProgress))) failed += 1;
  }
  return failed ? 1 : 0;
}

async function commandDown(ctx: SessionContext, names: string[]): Promise<number> {
  const modules = names.length ? resolveModules(ctx.session, names) : ctx.session.modules;
  if (!modules) return 1;
  const containers = await listKitContainers();
  let failed = 0;
  for (const module of modules) {
    if (profileState(containers, module.profile) === 'stopped') {
      if (names.length) line(`${module.title} уже остановлен`);
      continue;
    }
    if (!(await stopModule(module, consoleProgress))) failed += 1;
  }
  return failed ? 1 : 0;
}

async function commandReset(ctx: SessionContext, args: string[]): Promise<number> {
  const names = args.filter((arg) => arg !== '--yes');
  if (names.length !== 1) {
    errorLine('Укажите один стенд: ./stand reset kit-postgres');
    return 1;
  }
  const modules = resolveModules(ctx.session, names);
  const module = modules?.[0];
  if (!module) return 1;
  if (!args.includes('--yes')) {
    if (!process.stdin.isTTY) {
      errorLine('Без терминала добавьте --yes: ./stand reset <стенд> --yes');
      return 1;
    }
    const agreed = await confirm({
      message: `Удалить контейнеры и все данные стенда «${module.title}»?`,
      default: false,
    });
    if (!agreed) return 0;
  }
  return (await resetModule(module, consoleProgress)) ? 0 : 1;
}

async function runTaskCommand(
  runtime: Runtime,
  ctx: SessionContext,
  command: string,
  args: string[],
): Promise<number> {
  const tasks = await import('./tasks.js');
  if (command === 'tasks') {
    tasks.printTaskList(ctx.session);
    return 0;
  }
  if (command === 'task' && args[0] !== 'start') return tasks.showCurrentTask(runtime);
  if (command === 'task') {
    if (!args[1]) {
      errorLine('Укажите задачу: ./stand task start 1');
      return 1;
    }
    return (await tasks.startTaskFlow(runtime, ctx.session, args.slice(1).join(' '), consoleProgress)) ? 0 : 1;
  }
  if (command === 'check') {
    const outcome = await tasks.checkFlow(runtime, consoleProgress);
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
    clearConfig(runtime.dataDir);
    line('Токен удалён с этого компьютера. Запущенные стенды продолжают работать: ./stand down');
    return 0;
  }
  if (command === 'doctor') return runDoctor(runtime);
  if (command === 'agent') return runAgent(runtime);
  if (command && !['start', 'status', 'up', 'down', 'restart', 'reset', 'tasks', 'task', 'check', 'verify'].includes(command)) {
    errorLine(`Неизвестная команда: ${command}\n\n${USAGE}`);
    return 1;
  }

  printNotices(runtime, Boolean(command));
  const ctx = await loadSession(runtime, interactive);
  if (!ctx) return 1;
  if ((!command || command === 'start') && shouldSelfUpdate(runtime, ctx)) {
    line(`Вышла версия набора ${ctx.session.kit.latestVersion} — обновляю.`);
    return UPDATE_EXIT_CODE;
  }
  if (command === 'start') {
    const outcome = await startProjectFlow(runtime, ctx.session, consoleProgress);
    if (!outcome.hasProject) line('Учебного проекта пока нет: стенды запускаются через меню ./stand.');
    return outcome.code;
  }
  if (!command) {
    if (!interactive) {
      await printStatus(runtime, ctx);
      return 0;
    }
    const outcome = await startProjectFlow(runtime, ctx.session, consoleProgress);
    if (outcome.hasProject) line();
    await runMenu(runtime, ctx);
    return 0;
  }
  if (command === 'status') {
    await printStatus(runtime, ctx);
    return 0;
  }
  if (command === 'up') return commandUp(runtime, ctx, args);
  if (command === 'down') return commandDown(ctx, args);
  if (command === 'restart') {
    if (!args.length) {
      errorLine('Укажите стенды: ./stand restart kit-bank');
      return 1;
    }
    const stopped = await commandDown(ctx, args);
    return stopped === 0 ? commandUp(runtime, ctx, args) : stopped;
  }
  if (command === 'reset') return commandReset(ctx, args);
  return runTaskCommand(runtime, ctx, command!, args);
}
