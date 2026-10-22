export class BankClock {
  private offsetMs: number;

  constructor(
    private readonly realNow: () => number = Date.now,
    initialOffsetMs = 0,
  ) {
    this.offsetMs = initialOffsetMs;
  }

  now(): Date {
    return new Date(this.realNow() + this.offsetMs);
  }

  getOffsetMs(): number {
    return this.offsetMs;
  }

  setOffsetMs(offsetMs: number): void {
    this.offsetMs = offsetMs;
  }

  shiftTo(target: Date): number {
    this.offsetMs = target.getTime() - this.realNow();
    return this.offsetMs;
  }

  reset(): void {
    this.offsetMs = 0;
  }
}
