class TestLockManager implements LockManager {
  readonly #tails = new Map<string, Promise<void>>();

  async query(): Promise<LockManagerSnapshot> {
    return { held: [], pending: [] };
  }

  request<T>(name: string, callback: LockGrantedCallback<T>): Promise<Awaited<T>>;
  request<T>(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<Awaited<T>>;
  async request<T>(
    name: string,
    optionsOrCallback: LockOptions | LockGrantedCallback<T>,
    callbackArgument?: LockGrantedCallback<T>,
  ): Promise<Awaited<T>> {
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : callbackArgument;
    if (!callback) {
      throw new Error("A lock callback is required.");
    }
    const mode =
      typeof optionsOrCallback === "function"
        ? "exclusive"
        : (optionsOrCallback.mode ?? "exclusive");
    const previous = this.#tails.get(name) ?? Promise.resolve();
    let releaseQueue: (() => void) | undefined;
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    this.#tails.set(name, queued);

    return await previous
      .then(() => callback({ mode, name }))
      .finally(() => {
        releaseQueue?.();
        if (this.#tails.get(name) === queued) {
          this.#tails.delete(name);
        }
      });
  }
}

export function installTestWebAccountStateLocks(): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: new TestLockManager(),
  });
}
