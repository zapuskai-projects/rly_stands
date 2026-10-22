export class Readiness {
  private readonly parts = new Map<string, () => boolean>();

  add(name: string, ready: () => boolean): void {
    this.parts.set(name, ready);
  }

  pending(): string[] {
    return [...this.parts].filter(([, ready]) => !ready()).map(([name]) => name);
  }

  isReady(): boolean {
    return this.pending().length === 0;
  }
}
