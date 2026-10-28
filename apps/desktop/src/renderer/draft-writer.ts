/** Serialize draft writes and keep each latest value until its write succeeds. */
export class DraftWriter<T> {
  private pending = new Map<string, { value: T }>();
  private flushing: Promise<void> | null = null;

  /** The save callback receives a draft ID and value. It must reject on write failure. */
  constructor(private save: (id: string, value: T) => Promise<unknown>) {}

  /** Keep a value for this ID. A newer value replaces only the unsaved value for that ID. */
  set(id: string, value: T): void {
    this.pending.set(id, { value });
  }

  /** Get the last unsaved value for this ID, including a write in progress, or undefined. */
  get(id: string): T | undefined {
    return this.pending.get(id)?.value;
  }

  /** True if any draft has no write confirmation, including a write in progress. */
  get dirty(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Resolve after all queued drafts have write confirmation, including edits received during a write.
   * Concurrent callers share the active operation. A failed write rejects all those callers.
   * Keep the last unsaved value for each ID after failure. A subsequent call retries these values.
   */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = Promise.resolve().then(async () => {
        try {
          while (this.pending.size) {
            const [id, entry] = this.pending.entries().next().value!;
            await this.save(id, entry.value);
            if (this.pending.get(id) === entry) this.pending.delete(id);
          }
        } finally {
          this.flushing = null;
        }
      });
    }
    return this.flushing;
  }
}
