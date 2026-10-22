import { formatRubles, type Kopecks } from '../accounts/money';
import { maskPhone } from '../clients/names';
import { BANK } from '../shared/bank-identity';

export interface CompletedTransferFacts {
  type: 'OWN_TRANSFER' | 'PHONE_TRANSFER';
  amount: Kopecks;
  operationNumber: string;
  recipientName: string | null;
  recipientPhone: string | null;
  recipientBankName: string | null;
  senderShortName: string;
}

export interface ChannelTexts {
  sms: string;
  push: string;
}

function endSentence(text: string): string {
  return text.endsWith('.') ? text : `${text}.`;
}

function describeRecipient(facts: CompletedTransferFacts): string {
  if (facts.type === 'OWN_TRANSFER') return 'между вашими счетами';
  if (facts.recipientName) return `получателю ${facts.recipientName}`;
  const phone = facts.recipientPhone ? maskPhone(facts.recipientPhone) : 'получателю';
  return facts.recipientBankName ? `на номер ${phone} (${facts.recipientBankName})` : `на номер ${phone}`;
}

export function senderTexts(facts: CompletedTransferFacts): ChannelTexts {
  const amount = formatRubles(facts.amount);
  const where = describeRecipient(facts);
  return {
    sms: `${BANK.name}: перевод ${amount} ${where} выполнен. Операция ${facts.operationNumber}.`,
    push: `Перевод выполнен: ${amount} ${where}`,
  };
}

export function recipientTexts(facts: CompletedTransferFacts): ChannelTexts {
  const amount = formatRubles(facts.amount);
  return {
    sms: `${BANK.name}: вам поступил перевод ${amount}. ${endSentence(`Отправитель: ${facts.senderShortName}`)} Операция ${facts.operationNumber}.`,
    push: `Вам поступил перевод ${amount}. Отправитель: ${facts.senderShortName}`,
  };
}
