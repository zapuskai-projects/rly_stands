export type MemoryModule = { title: string; minMemoryMb: number; key?: string };

export type MemoryVerdict =
  | { ok: true }
  | { ok: false; needMb: number; freeMb: number; totalMb: number; stopTitles: string[] };

const HEADROOM_PERCENT = 110;

/** `keep` — ключи стендов, без которых кандидат не работает: их остановить не предлагаем. */
export function checkMemory(
  totalMb: number,
  running: MemoryModule[],
  candidate: MemoryModule,
  keep: string[] = [],
): MemoryVerdict {
  const needMb = Math.ceil((candidate.minMemoryMb * HEADROOM_PERCENT) / 100);
  const usedMb = running.reduce((sum, module) => sum + module.minMemoryMb, 0);
  const freeMb = Math.max(0, totalMb - usedMb);
  if (freeMb >= needMb) return { ok: true };
  if (totalMb < needMb) return { ok: false, needMb, freeMb, totalMb, stopTitles: [] };
  const stopTitles: string[] = [];
  let freed = freeMb;
  const stoppable = running.filter((module) => !module.key || !keep.includes(module.key));
  for (const module of [...stoppable].sort((a, b) => b.minMemoryMb - a.minMemoryMb)) {
    if (freed >= needMb) break;
    stopTitles.push(`${module.title} (${module.minMemoryMb} МБ)`);
    freed += module.minMemoryMb;
  }
  // Даже остановка всего лишнего не поможет — советовать нечего, только прибавить память.
  return { ok: false, needMb, freeMb, totalMb, stopTitles: freed >= needMb ? stopTitles : [] };
}

export function memoryRefusal(verdict: Extract<MemoryVerdict, { ok: false }>): string {
  if (verdict.totalMb < verdict.needMb) {
    return `нужно ${verdict.needMb} МБ, Docker отдано ${verdict.totalMb} МБ. Прибавьте память Docker в настройках`;
  }
  const base = `нужно ${verdict.needMb} МБ, свободно ${verdict.freeMb} МБ`;
  return verdict.stopTitles.length
    ? `${base}. Остановите: ${verdict.stopTitles.join(', ')}`
    : `${base}. Прибавьте память Docker в настройках`;
}
