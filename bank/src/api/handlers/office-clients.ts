import type { Pool } from 'pg';
import { listClientAccounts, sumActiveHolds } from '../../accounts/accounts.repository';
import { fromApiAmount, toApiAmount } from '../../accounts/money';
import type { BankClock } from '../../clock/bank-clock';
import { findClientById, findDailyLimitOverride } from '../../clients/clients.repository';
import { findOfficeClient, listOfficeClients, setDailyLimitOverride } from '../../office/clients.repository';
import { listClientRecentOperations } from '../../office/operations.repository';
import { forbidden, notFound } from '../../shared/errors';
import { getTariff } from '../../tariffs/tariffs.repository';
import { profileDto, tariffDto } from '../dto';
import { officeClientDto, officeOperationRowDto } from '../dto-office';
import { buildClientLimits } from '../limits';
import type { Handler, HandlerContext } from '../router';

interface Deps {
  pool: Pool;
  clock: BankClock;
}

const DEFAULT_PAGE_SIZE = 20;
const RECENT_OPERATIONS = 10;
const clientIdOf = (ctx: HandlerContext): string => String(ctx.params.clientId);

async function clientDetails(pool: Pool, clock: BankClock, clientId: string) {
  const row = await findOfficeClient(pool, clientId);
  const client = await findClientById(pool, clientId);
  if (!row || !client) throw notFound('CLIENT_NOT_FOUND', 'Клиент не найден');
  const accounts = await listClientAccounts(pool, clientId);
  const holds = await sumActiveHolds(pool, accounts.map((account) => account.id));
  const tariff = await getTariff(pool, client.tariffCode);
  const limits = await buildClientLimits(pool, client, tariff, clock.now());
  const override = await findDailyLimitOverride(pool, clientId);
  const recent = await listClientRecentOperations(pool, clientId, RECENT_OPERATIONS);
  return {
    client: officeClientDto(row),
    accounts: accounts.map((account) => {
      const held = holds.get(account.id) ?? 0n;
      return {
        id: account.id,
        number: account.number,
        kind: account.kind as 'CURRENT' | 'SAVINGS' | 'SETTLEMENT',
        title: account.title,
        status: account.status,
        balance: toApiAmount(account.balance),
        held: toApiAmount(held),
        available: toApiAmount(account.balance - held),
      };
    }),
    tariff: tariffDto(tariff),
    limits: profileDto(client, tariff, limits).limits,
    dailyLimitOverride: override === null ? null : toApiAmount(override),
    recentOperations: recent.map(officeOperationRowDto),
  };
}

export function officeClientHandlers({ pool, clock }: Deps): Record<string, Handler> {
  return {
    listOfficeClients: async (ctx) => {
      const limit = (ctx.query.limit as number | undefined) ?? DEFAULT_PAGE_SIZE;
      const offset = (ctx.query.offset as number | undefined) ?? 0;
      const query = String(ctx.query.query ?? '').trim() || null;
      const { rows, total } = await listOfficeClients(pool, query, limit, offset);
      return { status: 200, body: { items: rows.map(officeClientDto), total, limit, offset } };
    },
    getOfficeClient: async (ctx) => ({ status: 200, body: await clientDetails(pool, clock, clientIdOf(ctx)) }),
    setClientDailyLimit: async (ctx) => {
      if (ctx.operator?.role !== 'SENIOR') throw forbidden('FORBIDDEN_ROLE', 'Личные лимиты клиентов меняет старший оператор');
      const clientId = clientIdOf(ctx);
      if (!(await findClientById(pool, clientId))) throw notFound('CLIENT_NOT_FOUND', 'Клиент не найден');
      const value = (ctx.body as { dailyPhoneTransferLimit: number | null }).dailyPhoneTransferLimit;
      await setDailyLimitOverride(pool, clientId, value === null ? null : fromApiAmount(value));
      return { status: 200, body: await clientDetails(pool, clock, clientId) };
    },
  };
}

