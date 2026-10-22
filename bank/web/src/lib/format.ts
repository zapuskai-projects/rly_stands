const NO_BREAK = ' ';

export function formatMoney(kopecks: number): string {
  const negative = kopecks < 0;
  const absolute = Math.abs(kopecks);
  const whole = Math.floor(absolute / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NO_BREAK);
  const fraction = String(absolute % 100).padStart(2, '0');
  return `${negative ? '−' : ''}${whole},${fraction}${NO_BREAK}₽`;
}

export function formatWholeRubles(kopecks: number): string {
  const whole = Math.floor(Math.abs(kopecks) / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, NO_BREAK);
  return `${whole}${NO_BREAK}₽`;
}

export function formatSignedMoney(kopecks: number, direction: 'out' | 'in'): string {
  return `${direction === 'out' ? '−' : '+'}${formatMoney(Math.abs(kopecks))}`;
}

export function formatPhone(phone: string): string {
  const match = /^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(phone);
  return match ? `+7 ${match[1]} ${match[2]}-${match[3]}-${match[4]}` : phone;
}

export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, '');
  let national: string | null = null;
  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) national = digits.slice(1);
  else if (digits.length === 10) national = digits;
  return national && /^9\d{9}$/.test(national) ? `+7${national}` : null;
}

export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[\s ₽]/g, '').replace(',', '.');
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const kopecks = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  return kopecks > 0 && kopecks <= 1_000_000_000_000 ? kopecks : null;
}

export function timeOf(iso: string): string {
  return iso.slice(11, 16);
}

export function timeWithSeconds(iso: string): string {
  return iso.slice(11, 19);
}

export function dateKeyOf(iso: string): string {
  return iso.slice(0, 10);
}

export function shortDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
}

export function fullDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

export function dayAndTime(iso: string): string {
  return `${shortDate(iso)} ${timeOf(iso)}`;
}

export function shiftDateKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function dayLabel(dateKey: string, today: string): string {
  if (dateKey === today) return 'Сегодня';
  if (dateKey === shiftDateKey(today, -1)) return 'Вчера';
  return fullDate(dateKey);
}

export function initials(fullName: string): string {
  const words = fullName.split(/\s+/).filter((word) => word && word !== 'ИП');
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

export function remainingLabel(deadlineIso: string, nowIso: string): string {
  const seconds = Math.max(0, Math.floor((Date.parse(deadlineIso) - Date.parse(nowIso)) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Доброе утро';
  if (hour >= 12 && hour < 18) return 'Добрый день';
  if (hour >= 18) return 'Добрый вечер';
  return 'Доброй ночи';
}

export function formatAccountNumber(number: string): string {
  const match = /^(\d{5})(\d{3})(\d)(\d{4})(\d{7})$/.exec(number);
  return match ? `${match[1]} ${match[2]} ${match[3]} ${match[4]} ${match[5]}` : number;
}

export function lastDigits(maskedCard: string): string {
  return maskedCard.slice(-4);
}

export function formatAmountShort(kopecks: number): string {
  return kopecks % 100 === 0 ? formatWholeRubles(kopecks) : formatMoney(kopecks);
}

export function parseAmountOrZero(input: string): number | null {
  const cleaned = input.replace(/[\s\u00a0₽]/g, '').replace(',', '.');
  if (cleaned === '' || /^0+([.,]0{1,2})?$/.test(cleaned)) return cleaned === '' ? null : 0;
  return parseAmount(input);
}

export function parsePercent(input: string): number | null {
  const match = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(input.replace(/[\s%]/g, ''));
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  return bps <= 10_000 ? bps : null;
}

export function kopecksToInput(kopecks: number): string {
  const whole = Math.floor(kopecks / 100);
  const fraction = kopecks % 100;
  return fraction === 0 ? String(whole) : `${whole},${String(fraction).padStart(2, '0')}`;
}

export function bpsToPercentText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const fraction = bps % 100;
  if (fraction === 0) return String(whole);
  return `${whole},${String(fraction).padStart(2, '0').replace(/0$/, '')}`;
}
