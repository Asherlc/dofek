/**
 * Simple counting semaphore for limiting concurrent async operations.
 * Used to prevent overwhelming the database with too many heavy queries at once.
 */
export class Semaphore {
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.running--;
    }
  }
}

/** Limit concurrent DB queries to prevent overwhelming postgres with heavy analytics queries. */
export const dbQuerySemaphore = new Semaphore(3);
