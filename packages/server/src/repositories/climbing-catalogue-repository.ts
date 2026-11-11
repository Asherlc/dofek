import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { TRPCError } from "@trpc/server";
import { ClimbingCatalogueService } from "dofek/climbing-catalogue";
import type { Database } from "dofek/db";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { loadCatalogueSeed } from "dofek/db/climbing-catalogue-seed";
import {
  enqueueClimbingCatalogueRefresh,
  getClimbingCatalogueRefreshState,
} from "dofek/jobs/queues";
import { queryCache } from "dofek/lib/cache";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";

type CatalogueDatabase = Pick<Database, "execute" | "transaction">;
export class ClimbingCatalogueRepository extends BaseRepository<CatalogueDatabase> {
  readonly #service: ClimbingCatalogueService;
  constructor(
    db: CatalogueDatabase,
    userId: string,
    timezone: string,
    accessWindow?: AccessWindow,
    service = new ClimbingCatalogueService(queryCache, []),
  ) {
    super(db, userId, timezone, accessWindow);
    this.#service = service;
  }

  async #seed(id: string, db: Pick<Database, "execute"> = this.db): Promise<CatalogueSeed> {
    const logs = await new ClimbingActivityLogEntryRepository(
      db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).getLogEntries([id]);
    if (!logs.length) throw new TRPCError({ code: "NOT_FOUND", message: "Climbing log not found" });
    const seed = await loadCatalogueSeed(db, this.userId, id);
    if (!seed) throw new TRPCError({ code: "NOT_FOUND", message: "Climbing log not found" });
    return seed;
  }

  async #context(seed: CatalogueSeed) {
    const pending = await getClimbingCatalogueRefreshState(seed.userId, seed.logEntryId);
    const context = await this.#service.read(seed);
    return pending ? { ...context, status: "pending" as const, error: null } : context;
  }

  async read(id: string) {
    return this.#context(await this.#seed(id));
  }

  async requestRefresh(id: string) {
    return withAccountErasureUserWriteFence(this.db, this.userId, async (transaction) => {
      const seed = await this.#seed(id, transaction);
      try {
        await enqueueClimbingCatalogueRefresh(seed);
      } catch (error) {
        await this.#service.markFailed(seed, error);
        throw error;
      }
      return this.#context(seed);
    });
  }
}
