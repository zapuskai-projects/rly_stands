const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface MoscowParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

export function moscowParts(instant: Date): MoscowParts {
  const shifted = new Date(instant.getTime() + MOSCOW_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
  };
}

function moscowMidnight(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day) - MOSCOW_OFFSET_MS);
}

export function moscowDayStart(instant: Date): Date {
  const p = moscowParts(instant);
  return moscowMidnight(p.year, p.month - 1, p.day);
}

export function moscowNextDayStart(instant: Date): Date {
  const p = moscowParts(instant);
  return moscowMidnight(p.year, p.month - 1, p.day + 1);
}

export function moscowMonthStart(instant: Date): Date {
  const p = moscowParts(instant);
  return moscowMidnight(p.year, p.month - 1, 1);
}

export function moscowNextMonthStart(instant: Date): Date {
  const p = moscowParts(instant);
  return moscowMidnight(p.year, p.month, 1);
}

export function moscowDateKey(instant: Date): string {
  const p = moscowParts(instant);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function parseMoscowDate(dateKey: string): Date | null {
  const match = DATE_KEY.exec(dateKey);
  if (!match) return null;
  const start = moscowMidnight(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return moscowDateKey(start) === dateKey ? start : null;
}

export function toMoscowIso(instant: Date): string {
  const p = moscowParts(instant);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(p.millisecond, 3)}+03:00`;
}
