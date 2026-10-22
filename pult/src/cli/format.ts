const pad = (value: number) => String(value).padStart(2, '0');

export function formatShortDate(iso: string, withTime = false): string {
  const date = new Date(iso);
  const day = `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
  return withTime ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

export function formatClock(date = new Date()): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
