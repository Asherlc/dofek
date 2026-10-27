import type { CatalogueSeed } from "@dofek/training/climbing-catalogue";
import { ClimbingCatalogueService } from "../climbing-catalogue.ts";
import { createClimbingCatalogueAdapters } from "../climbing-catalogue-sources.ts";
import { loadCatalogueSeed } from "../db/climbing-catalogue-seed.ts";
import type { Database } from "../db/index.ts";
import { type CacheStore, queryCache } from "../lib/cache.ts";
import { accountErasureAllowsQueuedUserWork } from "./account-erasure-work-guard.ts";
import { type ClimbingCatalogueJobData, climbingCatalogueJobDataSchema } from "./queues.ts";

/** Runs inside the existing post-sync worker's shared account-erasure work barrier. */
export async function processClimbingCatalogueJob(
  input: ClimbingCatalogueJobData,
  db: Pick<Database, "execute" | "select">,
  cache: CacheStore = queryCache,
): Promise<void> {
  const { userId, logEntryId, seed: queuedSeed } = climbingCatalogueJobDataSchema.parse(input);
  const failures = new ClimbingCatalogueService(cache, []);
  let seed: CatalogueSeed | null;
  let adapters: ReturnType<typeof createClimbingCatalogueAdapters>;
  try {
    if (!(await accountErasureAllowsQueuedUserWork(db, userId, "climbing catalogue lookup")))
      return;
    seed = await loadCatalogueSeed(db, userId, logEntryId);
    if (!seed) return;
    adapters = createClimbingCatalogueAdapters(userId, db);
  } catch (error) {
    await failures.markFailed(queuedSeed, error);
    throw error;
  }
  const service = new ClimbingCatalogueService(cache, adapters);
  await service.refresh(seed);
  try {
    const current = await loadCatalogueSeed(db, userId, logEntryId);
    if (JSON.stringify(current) !== JSON.stringify(seed)) await service.invalidate(seed);
  } catch (error) {
    await service.markFailed(seed, error);
    throw error;
  }
}
