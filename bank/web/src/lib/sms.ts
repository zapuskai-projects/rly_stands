import type { SmsMessage } from './types';

export interface SmsView {
  message: SmsMessage;
  code: string | null;
  canFill: boolean;
  replaced: boolean;
}

export function extractCode(text: string): string | null {
  return /\b(\d{6})\b/.exec(text)?.[1] ?? null;
}

export function smsViews(messages: readonly SmsMessage[]): SmsView[] {
  return messages.map((message, index) => {
    const code = extractCode(message.text);
    return { message, code, canFill: code !== null && index === 0, replaced: code !== null && index > 0 };
  });
}
