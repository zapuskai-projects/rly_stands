const DAY_MS = 24 * 60 * 60 * 1000;

export function utcDayStart(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / DAY_MS) * DAY_MS);
}

export function utcNextDayStart(instant: Date): Date {
  return new Date(utcDayStart(instant).getTime() + DAY_MS);
}
