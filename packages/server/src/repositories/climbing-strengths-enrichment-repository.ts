import type { CatalogueSeed, ClimbingCatalogueContext } from "@dofek/training/climbing-catalogue";
import { ClimbingCatalogueService, catalogueSeedCacheKey } from "dofek/climbing-catalogue";
import type { Database } from "dofek/db";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { loadCatalogueSeeds } from "dofek/db/climbing-catalogue-seed";
import {
  enqueueClimbingCatalogueRefresh,
  getClimbingCatalogueRefreshState,
} from "dofek/jobs/queues";
import { queryCache } from "dofek/lib/cache";
import type { AccessWindow } from "../billing/entitlement.ts";
import { BaseRepository } from "../lib/base-repository.ts";

type CatalogueDatabase = Pick<Database, "execute" | "transaction">;

/** Callers supply log IDs from their already authorized observation window. */
export class ClimbingStrengthsEnrichmentRepository extends BaseRepository<CatalogueDatabase> {
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

  async getContexts(logEntryIds: string[]): Promise<{
    seeds: Map<string, CatalogueSeed>;
    contexts: Map<string, ClimbingCatalogueContext>;
    pending: boolean;
    errors: string[];
  }> {
    const contexts = new Map<string, ClimbingCatalogueContext>();
    if (logEntryIds.length === 0) return { seeds: new Map(), contexts, pending: false, errors: [] };
    const seeds = await loadCatalogueSeeds(this.db, this.userId, logEntryIds);
    const groups = new Map<string, CatalogueSeed[]>();
    for (const seed of seeds) {
      if (!seed.name && !seed.externalId && !seed.sourceUrl) continue;
      const key = catalogueSeedCacheKey(seed);
      const group = groups.get(key);
      if (group) group.push(seed);
      else groups.set(key, [seed]);
    }
    let pending = false;
    const errors = new Set<string>();
    for (const group of groups.values()) {
      group.sort((left, right) => left.logEntryId.localeCompare(right.logEntryId));
      const seed = group[0];
      if (!seed) continue;
      let context = await this.#service.read(seed);
      const state = await getClimbingCatalogueRefreshState(seed.userId, seed.logEntryId);
      if (state === "pending") context = { ...context, status: "pending", error: null };
      else if (context.status === "missing") {
        await withAccountErasureUserWriteFence(this.db, this.userId, async () => {
          try {
            await enqueueClimbingCatalogueRefresh(seed);
          } catch (error) {
            await this.#service.markFailed(seed, error);
          }
        });
        context = await this.#service.read(seed);
        if (context.status === "missing") context = { ...context, status: "pending", error: null };
      }
      if (context.status === "pending") pending = true;
      if (context.error) errors.add(context.error);
      for (const entry of group) contexts.set(entry.logEntryId, context);
    }
    return {
      seeds: new Map(seeds.map((seed) => [seed.logEntryId, seed])),
      contexts,
      pending,
      errors: [...errors],
    };
  }
}
