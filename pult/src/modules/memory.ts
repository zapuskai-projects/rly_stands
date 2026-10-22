export type MemoryModule = { title: string; minMemoryMb: number };

export type MemoryVerdict =
  | { ok: true }
  | { ok: false; needMb: number; freeMb: number; totalMb: number; stopTitles: string[] };

const HEADROOM_PERCENT = 110;

export function checkMemory(
  totalMb: number,
  running: MemoryModule[],
  candidate: MemoryModule,
): MemoryVerdict {
  const needMb = Math.ceil((candidate.minMemoryMb * HEADROOM_PERCENT) / 100);
  const usedMb = running.reduce((sum, module) => sum + module.minMemoryMb, 0);
  const freeMb = Math.max(0, totalMb - usedMb);
  if (freeMb >= needMb) return { ok: true };
  if (totalMb < needMb) return { ok: false, needMb, freeMb, totalMb, stopTitles: [] };
  const stopTitles: string[] = [];
  let freed = freeMb;
  for (const module of [...running].sort((a, b) => b.minMemoryMb - a.minMemoryMb)) {
    if (freed >= needMb) break;
    stopTitles.push(`${module.title} (${module.minMemoryMb} МБ)`);
    freed += module.minMemoryMb;
  }
  return { ok: false, needMb, freeMb, totalMb, stopTitles };
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
