export type SyncDrain = (reasons: readonly string[]) => Promise<boolean>;

interface SyncRetryOptions {
  retryBaseDelayMs: number;
  maxRetryAttempts: number;
  onRetryError(error: unknown): void;
}

export class SyncCoordinator {
  readonly #drain: SyncDrain;
  readonly #retryOptions: SyncRetryOptions | null;
  readonly #pendingReasons = new Set<string>();
  #inFlight: Promise<void> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retryAttempts = 0;

  constructor(drain: SyncDrain, retryOptions: SyncRetryOptions | null = null) {
    this.#drain = drain;
    this.#retryOptions = retryOptions;
  }

  requestDrain(reason: string): Promise<void> {
    if (reason !== "retry" && this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#pendingReasons.add(reason);
    if (this.#inFlight) {
      return this.#inFlight;
    }

    this.#inFlight = this.#run();
    return this.#inFlight;
  }

  async #run(): Promise<void> {
    try {
      while (this.#pendingReasons.size > 0) {
        const reasons = [...this.#pendingReasons];
        this.#pendingReasons.clear();
        const succeeded = await this.#drain(reasons);
        if (succeeded === false) {
          this.#scheduleRetry();
          break;
        }
      }
      this.#inFlight = null;
      if (this.#retryTimer === null) this.#retryAttempts = 0;
    } catch (error) {
      this.#inFlight = null;
      throw error;
    }
  }

  #scheduleRetry(): void {
    const options = this.#retryOptions;
    if (!options || this.#retryTimer !== null || this.#retryAttempts >= options.maxRetryAttempts) {
      return;
    }
    const delay = options.retryBaseDelayMs * 2 ** this.#retryAttempts;
    this.#retryAttempts += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.requestDrain("retry").catch((error: unknown) => options.onRetryError(error));
    }, delay);
  }
}
