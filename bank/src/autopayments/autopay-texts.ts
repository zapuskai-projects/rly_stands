import { formatRubles, type Kopecks } from '../accounts/money';
import type { ChannelTexts } from '../notifications/texts';
import { BANK } from '../shared/bank-identity';
import { MAX_ATTEMPTS, RUN_HOUR } from './schedule';

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

const REASONS: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'недостаточно средств на счёте',
  DAILY_LIMIT_EXCEEDED: 'превышен суточный лимит переводов',
  ACCOUNT_ARRESTED: 'на счёт наложен арест',
  NON_RESIDENT_EXTERNAL_TRANSFER: 'переводы в другие банки недоступны нерезидентам',
  ANTIFRAUD_REJECTED: 'перевод отклонён проверкой банка',
  OPERATOR_REJECTED: 'перевод отклонён специалистом банка',
  REVIEW_EXPIRED: 'истёк срок проверки перевода',
  RECIPIENT_NOT_FOUND: 'получатель не найден',
  RECIPIENT_IS_SENDER: 'получатель совпадает с отправителем',
  UNKNOWN_BANK: 'банк получателя не найден',
  ACCOUNT_NOT_FOUND: 'счёт не найден',
  SAME_ACCOUNT: 'счета списания и зачисления совпадают',
  CLIENT_BLOCKED: 'операции клиента приостановлены',
  SBP_REJECTED: 'банк получателя не принял перевод',
  SBP_UNAVAILABLE: 'система быстрых платежей недоступна',
  SBP_TIMEOUT: 'банк получателя не ответил вовремя',
  AUTOPAYMENT_CANCELLED: 'автоплатёж отменён',
  AUTOPAYMENT_PAUSED: 'автоплатёж поставлен на паузу',
  TEMPLATE_NOT_FOUND: 'шаблон удалён',
};

export function reasonText(code: string | null): string {
  return (code ? REASONS[code] : undefined) ?? 'банк не смог выполнить перевод';
}

export function dayAndMonth(dateKey: string): string {
  const [, month = 1, day = 1] = dateKey.split('-').map(Number);
  return `${day} ${MONTHS[month - 1]}`;
}

const title = (name: string) => `автоплатёж «${name}»`;
const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

export interface AutopayFacts {
  name: string;
  amount: Kopecks;
}

export function reminderTexts(facts: AutopayFacts, runOn: string): ChannelTexts {
  const amount = formatRubles(facts.amount);
  return {
    sms: `${BANK.name}: завтра, ${dayAndMonth(runOn)}, спишется ${title(facts.name)}: ${amount}. Проверьте остаток на счёте.`,
    push: `Завтра ${title(facts.name)}: ${amount}`,
  };
}

export function executedTexts(facts: AutopayFacts, operationNumber: string | null): ChannelTexts {
  const amount = formatRubles(facts.amount);
  const operation = operationNumber ? ` Операция ${operationNumber}.` : '';
  return {
    sms: `${BANK.name}: ${title(facts.name)} выполнен: ${amount}.${operation}`,
    push: `${capitalize(title(facts.name))} выполнен: ${amount}`,
  };
}

export type FailureEnding = 'STOPPED' | 'ENDED' | 'PAUSED';

export function failedTexts(facts: AutopayFacts, reasonCode: string | null, attempt: number, retryOn: string | null, ending: FailureEnding = 'STOPPED'): ChannelTexts {
  const reason = reasonText(reasonCode);
  const head = `${BANK.name}: ${title(facts.name)} не выполнен: ${reason}.`;
  const push = `${capitalize(title(facts.name))} не выполнен: ${reason}`;
  if (retryOn) {
    return {
      sms: `${head} Повторим ${dayAndMonth(retryOn)} в ${RUN_HOUR}:00, попытка ${attempt + 1} из ${MAX_ATTEMPTS}.`,
      push: `${push}. Повторим ${dayAndMonth(retryOn)}`,
    };
  }
  if (ending === 'ENDED') return { sms: `${head} Автоплатёж завершён, повторов не будет.`, push: `${push}. Повторов не будет` };
  if (ending === 'PAUSED') return { sms: `${head} Автоплатёж на паузе: возобновить его можно в интернет-банке.`, push: `${push}. Автоплатёж на паузе` };
  return { sms: `${head} Автоплатёж остановлен: возобновить его можно в интернет-банке.`, push: `${push}. Автоплатёж остановлен` };
}
