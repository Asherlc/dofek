export type SyncDrain = (reasons: readonly string[]) => Promise<void>;

export class SyncCoordinator {
  readonly #drain: SyncDrain;
  readonly #pendingReasons = new Set<string>();
  #inFlight: Promise<void> | null = null;

  constructor(drain: SyncDrain) {
    this.#drain = drain;
  }

  requestDrain(reason: string): Promise<void> {
    this.#pendingReasons.add(reason);
    if (this.#inFlight) {
      return this.#inFlight;
    }

    this.#inFlight = this.#run().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #run(): Promise<void> {
    while (this.#pendingReasons.size > 0) {
      const reasons = [...this.#pendingReasons];
      this.#pendingReasons.clear();
      await this.#drain(reasons);
    }
  }
}
