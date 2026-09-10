export type LimitedOperation<T> = () => Promise<T>;

/**
 * Runs asynchronous operations while never letting more than `concurrency` of
 * them execute at the same time. Extra operations wait in a first-in first-out
 * queue and start as running slots free up.
 *
 * Callers use this to keep a single request from demanding more shared
 * resources (for example PostgreSQL pool connections) than the resource holds.
 */
export class ConcurrencyLimiter {
  readonly #concurrency: number;
  #active = 0;
  readonly #queue: Array<() => void> = [];

  constructor(concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(
        `ConcurrencyLimiter concurrency must be a positive integer, got ${concurrency}`,
      );
    }
    this.#concurrency = concurrency;
  }

  get active(): number {
    return this.#active;
  }

  get queueDepth(): number {
    return this.#queue.length;
  }

  async run<T>(operation: LimitedOperation<T>): Promise<T> {
    await this.#acquire();
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#concurrency) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#queue.push(resolve);
    });
  }

  #release(): void {
    const next = this.#queue.shift();
    if (next) {
      // Hand the running slot straight to the next waiter without touching the
      // active count — the slot is transferred, not freed.
      next();
      return;
    }
    this.#active -= 1;
  }
}
