import type { Kopecks } from '../accounts/money';

export interface Tariff {
  code: string;
  name: string;
  dailyPhoneLimit: Kopecks;
  freeMonthlyVolume: Kopecks;
  commissionRateBps: number;
  commissionMin: Kopecks;
  commissionMax: Kopecks;
}
