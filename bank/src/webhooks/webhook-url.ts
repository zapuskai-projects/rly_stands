import { classifyAddress } from './address-guard';

export const WEBHOOK_URL_MAX = 500;

export function webhookUrlIssue(value: string): string | null {
  if (value.length > WEBHOOK_URL_MAX) return `Адрес длиннее ${WEBHOOK_URL_MAX} символов`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'Адрес не похож на ссылку, пример: http://host.docker.internal:8080/webhook';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Разрешены только адреса http и https';
  if (!parsed.hostname) return 'В адресе нет хоста';
  return null;
}

export const WEBHOOK_LOOPBACK_MESSAGE =
  'Банк работает в контейнере: адрес localhost для него — он сам. Укажите http://host.docker.internal:<порт>';

export function isLoopbackWebhookHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const kind = classifyAddress(host);
  return kind === 'LOOPBACK' || kind === 'UNSPECIFIED';
}
