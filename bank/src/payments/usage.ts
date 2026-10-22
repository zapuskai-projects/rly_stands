import type { Kopecks } from '../accounts/money';
import { moscowDayStart, moscowMonthStart, moscowNextDayStart, moscowNextMonthStart } from '../clock/moscow';
import { utcDayStart, utcNextDayStart } from '../clock/utc';
import type { Db } from '../db/pool';
import { NO_DEFECTS, type DefectSet } from '../defects/catalog';
import { sumPhoneTransferVolume } from './operations.repository';

export interface PhoneTransferUsage {
  usedToday: Kopecks;
  usedTodayByMoscowDay: Kopecks;
  usedThisMonthViaSbp: Kopecks;
  dayResetsAt: Date;
  monthResetsAt: Date;
}

export async function loadPhoneTransferUsage(db: Db, clientId: string, now: Date, defects: DefectSet = NO_DEFECTS): Promise<PhoneTransferUsage> {
  const usedTodayByMoscowDay = await sumPhoneTransferVolume(db, clientId, moscowDayStart(now), moscowNextDayStart(now));
  const byUtcDay = defects.has('daily-limit-utc');
  return {
    usedToday: byUtcDay ? await sumPhoneTransferVolume(db, clientId, utcDayStart(now), utcNextDayStart(now)) : usedTodayByMoscowDay,
    usedTodayByMoscowDay,
    usedThisMonthViaSbp: await sumPhoneTransferVolume(db, clientId, moscowMonthStart(now), moscowNextMonthStart(now), 'SBP'),
    dayResetsAt: byUtcDay ? utcNextDayStart(now) : moscowNextDayStart(now),
    monthResetsAt: moscowNextMonthStart(now),
  };
}
