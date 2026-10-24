import { formatMoney } from './format';
import type { QrStatus } from './types';

const BLOCK_REASON: Record<Exclude<QrStatus, 'CREATED'>, string> = {
  PAID: 'QR-код уже оплачен',
  PARTIALLY_REFUNDED: 'QR-код уже оплачен',
  REFUNDED: 'QR-код уже оплачен',
  EXPIRED: 'Срок действия QR-кода истёк',
  CANCELLED: 'Магазин отменил QR-код',
};

export function qrBlockReason(status: QrStatus): string | null {
  return status === 'CREATED' ? null : BLOCK_REASON[status];
}

export function payLabel(kopecks: number | null): string {
  if (kopecks === null) return 'Оплатить';
  return `Оплатить ${kopecks % 100 === 0 ? `${(kopecks / 100).toLocaleString('ru-RU')} ₽` : formatMoney(kopecks)}`;
}
