import type { Pool } from 'pg';
import { fromApiAmount } from '../../accounts/money';
import { listOfficeNotifications } from '../../office/notifications.repository';
import { forbidden, notFound, unprocessable } from '../../shared/errors';
import { listTariffs, updateTariffValues } from '../../tariffs/tariffs.repository';
import { tariffDto } from '../dto';
import { officeNotificationDto } from '../dto-office';
import type { Handler } from '../router';

const DEFAULT_PAGE_SIZE = 20;

interface TariffBody {
  dailyPhoneTransferLimit: number;
  freeMonthlyVolume: number;
  commissionRateBps: number;
  commissionMin: number;
  commissionMax: number;
}

export function officeSettingsHandlers(pool: Pool): Record<string, Handler> {
  return {
    listTariffs: async () => ({ status: 200, body: { items: (await listTariffs(pool)).map(tariffDto) } }),
    updateTariff: async (ctx) => {
      if (ctx.operator?.role !== 'SENIOR') throw forbidden('FORBIDDEN_ROLE', 'Тарифы меняет старший оператор');
      const body = ctx.body as TariffBody;
      if (body.commissionMin > body.commissionMax) {
        throw unprocessable('INVALID_TARIFF', 'Минимальная комиссия не может быть больше максимальной');
      }
      const updated = await updateTariffValues(pool, String(ctx.params.code), {
        dailyPhoneLimit: fromApiAmount(body.dailyPhoneTransferLimit),
        freeMonthlyVolume: fromApiAmount(body.freeMonthlyVolume),
        commissionRateBps: body.commissionRateBps,
        commissionMin: fromApiAmount(body.commissionMin),
        commissionMax: fromApiAmount(body.commissionMax),
      });
      if (!updated) throw notFound('TARIFF_NOT_FOUND', 'Тариф не найден');
      return { status: 200, body: tariffDto(updated) };
    },
    listOfficeNotifications: async (ctx) => {
      const limit = (ctx.query.limit as number | undefined) ?? DEFAULT_PAGE_SIZE;
      const offset = (ctx.query.offset as number | undefined) ?? 0;
      const filter = {
        phone: ctx.query.phone as string | undefined,
        kind: ctx.query.kind as string | undefined,
        channel: ctx.query.channel as string | undefined,
      };
      const { rows, total } = await listOfficeNotifications(pool, filter, limit, offset);
      return { status: 200, body: { items: rows.map(officeNotificationDto), total, limit, offset } };
    },
  };
}
