import { ClimbingBoardAccount } from "../lib/climbing-board-account.ts";
import { KilterBoardClient } from "../lib/kilter-board-client.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult, SyncRun } from "./types.ts";

export class KilterProvider implements SyncProvider {
  readonly id = "kilter";
  readonly name = "Kilter Board";
  readonly #account: ClimbingBoardAccount;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    const upstream = createProviderRateLimitFetch(this.id, fetchFn);
    this.#account = new ClimbingBoardAccount(
      this.id,
      this.name,
      "https://portal.kiltergrips.com",
      new KilterBoardClient(upstream),
    );
  }

  validate(): string | null {
    return null;
  }
  authSetup(): ProviderAuthSetup {
    return this.#account.authSetup();
  }
  sync(run: SyncRun): Promise<SyncResult> {
    return this.#account.sync(run);
  }
}
