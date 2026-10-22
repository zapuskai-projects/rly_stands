import type { Pool } from 'pg';
import {
  findClientAccountById,
  listCardsByAccounts,
  listClientAccounts,
  sumActiveHolds,
  type Account,
} from '../../accounts/accounts.repository';
import { buildStatement } from '../../accounts/statement';
import type { BankClock } from '../../clock/bank-clock';
import { moscowDateKey, moscowMonthStart, moscowNextDayStart, parseMoscowDate } from '../../clock/moscow';
import { findClientById } from '../../clients/clients.repository';
import { badRequest, notFound } from '../../shared/errors';
import { getTariff } from '../../tariffs/tariffs.repository';
import { accountDto, profileDto, statementDto } from '../dto';
import { buildClientLimits } from '../limits';
import type { Handler, HandlerContext } from '../router';

interface Deps {
  pool: Pool;
  clock: BankClock;
}

const clientIdOf = (ctx: HandlerContext): string => (ctx.session as { clientId: string }).clientId;

async function requireAccount(pool: Pool, ctx: HandlerContext): Promise<Account> {
  const account = await findClientAccountById(pool, clientIdOf(ctx), String(ctx.params.accountId));
  if (!account) throw notFound('ACCOUNT_NOT_FOUND', 'Счёт не найден');
  return account;
}

async function loadAccountDto(pool: Pool, account: Account) {
  const held = (await sumActiveHolds(pool, [account.id])).get(account.id) ?? 0n;
  const cards = await listCardsByAccounts(pool, [account.id]);
  return accountDto(account, held, cards);
}

export function accountHandlers({ pool, clock }: Deps): Record<string, Handler> {
  return {
    getProfile: async (ctx) => {
      const client = await findClientById(pool, clientIdOf(ctx));
      if (!client) throw notFound('CLIENT_NOT_FOUND', 'Клиент не найден');
      const tariff = await getTariff(pool, client.tariffCode);
      const limits = await buildClientLimits(pool, client, tariff, clock.now());
      return { status: 200, body: profileDto(client, tariff, limits) };
    },
    listAccounts: async (ctx) => {
      const accounts = await listClientAccounts(pool, clientIdOf(ctx));
      const ids = accounts.map((account) => account.id);
      const holds = await sumActiveHolds(pool, ids);
      const cards = await listCardsByAccounts(pool, ids);
      const items = accounts.map((account) =>
        accountDto(account, holds.get(account.id) ?? 0n, cards.filter((card) => card.accountId === account.id)),
      );
      return { status: 200, body: { items } };
    },
    getAccount: async (ctx) => {
      const account = await requireAccount(pool, ctx);
      return { status: 200, body: await loadAccountDto(pool, account) };
    },
    getStatement: async (ctx) => {
      const account = await requireAccount(pool, ctx);
      const now = clock.now();
      const fromKey = (ctx.query.from as string | undefined) ?? moscowDateKey(moscowMonthStart(now));
      const toKey = (ctx.query.to as string | undefined) ?? moscowDateKey(now);
      const from = parseMoscowDate(fromKey);
      const to = parseMoscowDate(toKey);
      if (!from || !to) throw badRequest('INVALID_PERIOD', 'Даты периода заданы неверно');
      if (from > to) throw badRequest('INVALID_PERIOD', 'Начало периода позже его конца');
      const data = await buildStatement(pool, account, from, moscowNextDayStart(to));
      return { status: 200, body: statementDto(account, fromKey, toKey, data) };
    },
  };
}
