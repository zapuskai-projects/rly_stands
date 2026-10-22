import type { Db } from '../db/pool';
import type { Client } from '../clients/clients.repository';
import { findDailyLimitOverride } from '../clients/clients.repository';
import { loadActiveDefects } from '../defects/defects.repository';
import { loadPhoneTransferUsage } from '../payments/usage';
import { remainingFreeVolume } from '../tariffs/commission';
import { effectiveDailyLimit } from '../tariffs/limits';
import type { Tariff } from '../tariffs/tariff';
import type { ClientLimits } from './dto';

export async function buildClientLimits(db: Db, client: Client | { id: string }, tariff: Tariff, now: Date): Promise<ClientLimits> {
  const usage = await loadPhoneTransferUsage(db, client.id, now, await loadActiveDefects(db));
  const dailyLimit = effectiveDailyLimit(tariff.dailyPhoneLimit, await findDailyLimitOverride(db, client.id));
  return {
    dailyPhoneTransfer: {
      limit: dailyLimit,
      used: usage.usedToday,
      remaining: dailyLimit > usage.usedToday ? dailyLimit - usage.usedToday : 0n,
      resetsAt: usage.dayResetsAt,
    },
    monthlyFreeVolume: {
      limit: tariff.freeMonthlyVolume,
      used: usage.usedThisMonthViaSbp,
      remaining: remainingFreeVolume(tariff.freeMonthlyVolume, usage.usedThisMonthViaSbp),
      resetsAt: usage.monthResetsAt,
    },
  };
}
