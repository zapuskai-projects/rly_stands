interface PendingWrite {
  label: string;
  done: Promise<void>;
}

export class PendingWrites {
  private readonly items = new Set<PendingWrite>();

  track(label: string | null, write: Promise<unknown>): void {
    if (label === null) return;
    const entry: PendingWrite = { label, done: write.then(() => undefined, () => undefined) };
    this.items.add(entry);
    void entry.done.then(() => this.items.delete(entry));
  }

  async settle(label: string, timeoutMs: number): Promise<void> {
    const waiting = [...this.items].filter((item) => item.label === label).map((item) => item.done);
    if (waiting.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([Promise.all(waiting), expired]);
    clearTimeout(timer);
  }
}
