import { formatRubles, type Kopecks } from '../accounts/money';
import { checkDailyLimit } from '../tariffs/limits';

export type RejectionCode = 'DAILY_LIMIT_EXCEEDED' | 'ACCOUNT_ARRESTED' | 'NON_RESIDENT_EXTERNAL_TRANSFER';

export interface Rejection {
  code: RejectionCode;
  message: string;
}

export interface RejectionInput {
  type: 'OWN_TRANSFER' | 'PHONE_TRANSFER';
  route: 'INTERNAL' | 'SBP';
  accountStatus: 'ACTIVE' | 'ARRESTED' | 'CLOSED';
  clientResident: boolean;
  amount: Kopecks;
  dailyLimit: Kopecks;
  usedToday: Kopecks;
  strictLimit?: boolean;
}

export function evaluateRejection(input: RejectionInput): Rejection | null {
  if (input.accountStatus === 'ARRESTED') {
    return { code: 'ACCOUNT_ARRESTED', message: 'По счёту наложен арест, расходные операции приостановлены' };
  }
  if (input.type === 'OWN_TRANSFER') return null;
  if (input.route === 'SBP' && !input.clientResident) {
    return { code: 'NON_RESIDENT_EXTERNAL_TRANSFER', message: 'Переводы в другие банки недоступны нерезидентам' };
  }
  const check = checkDailyLimit({ limit: input.dailyLimit, usedToday: input.usedToday, amount: input.amount, strict: input.strictLimit });
  if (!check.allowed) {
    return {
      code: 'DAILY_LIMIT_EXCEEDED',
      message: `Превышен суточный лимит переводов по телефону ${formatRubles(input.dailyLimit)}. Доступно сегодня: ${formatRubles(check.remaining)}`,
    };
  }
  return null;
}
