export function ageSecondsOf(createdAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / 1000));
}

export function hasKopecks(amountKop: bigint): boolean {
  return amountKop % 100n !== 0n;
}
