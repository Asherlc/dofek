import { AuroraBoardClient } from "../lib/aurora-board-client.ts";
import { ClimbingBoardAccount } from "../lib/climbing-board-account.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult, SyncRun } from "./types.ts";

export class AuroraBoardProvider implements SyncProvider {
  readonly id = "aurora-board";
  readonly name = "Aurora Board";
  readonly #account: ClimbingBoardAccount;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    const upstream = createProviderRateLimitFetch(this.id, fetchFn);
    this.#account = new ClimbingBoardAccount(
      this.id,
      this.name,
      "https://auroraboardapp.com",
      new AuroraBoardClient(this.id, this.name, "https://auroraboardapp.com", upstream),
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
