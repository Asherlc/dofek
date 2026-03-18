import { refreshDedupViews, updateUserMaxHr } from "../db/dedup.ts";
import type { SyncDatabase } from "../db/index.ts";
import { loadProviderPriorityConfig, syncProviderPriorities } from "../db/provider-priority.ts";
import { getEnabledProviders } from "../providers/index.ts";
import type { Provider, SyncResult } from "../providers/types.ts";

export interface SyncRunResult {
  results: SyncResult[];
  totalRecords: number;
  totalErrors: number;
  duration: number;
}

/**
 * Run sync for all enabled providers.
 * Each provider runs independently — one failure doesn't block others.
 */
export async function runSync(
  db: SyncDatabase,
  since: Date,
  providers?: Provider[],
): Promise<SyncRunResult> {
  const start = Date.now();
  const toSync = providers ?? getEnabledProviders();

  const results = await Promise.allSettled(
    toSync.map(async (provider) => {
      console.log(`[sync] Starting ${provider.name}...`);
      const result = await provider.sync(db, since);
      console.log(
        `[sync] ${provider.name}: ${result.recordsSynced} records, ${result.errors.length} errors`,
      );
      return result;
    }),
  );

  const settled: SyncResult[] = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    return {
      provider: toSync[index]?.id ?? "unknown",
      recordsSynced: 0,
      errors: [{ message: String(result.reason) }],
      duration: 0,
    };
  });

  // Update max HR from newly synced data
  try {
    console.log("[sync] Updating user max HR...");
    await updateUserMaxHr(db);
  } catch (err) {
    console.error("[sync] Failed to update max HR:", err);
  }

  // Apply provider priority config from JSON before refreshing views
  try {
    const priorityConfig = loadProviderPriorityConfig();
    if (priorityConfig) {
      await syncProviderPriorities(db, priorityConfig);
    }
  } catch (err) {
    console.error("[sync] Failed to apply provider priorities:", err);
  }

  // Refresh deduplication + rollup views after all providers have synced
  try {
    console.log("[sync] Refreshing materialized views...");
    await refreshDedupViews(db);
    console.log("[sync] Materialized views refreshed.");
  } catch (err) {
    console.error("[sync] Failed to refresh views:", err);
  }

  // Refit personalized algorithm parameters from updated data
  try {
    const { refitAllParams } = await import("../personalization/refit.ts");
    // CLI sync uses DEFAULT_USER_ID; worker sync uses process-sync-job.ts with job.data.userId
    const { DEFAULT_USER_ID } = await import("../db/schema.ts");
    console.log("[sync] Refitting personalized parameters...");
    await refitAllParams(db, DEFAULT_USER_ID);
    console.log("[sync] Personalized parameters updated.");
  } catch (err) {
    console.error("[sync] Failed to refit parameters:", err);
  }

  return {
    results: settled,
    totalRecords: settled.reduce((sum, result) => sum + result.recordsSynced, 0),
    totalErrors: settled.reduce((sum, result) => sum + result.errors.length, 0),
    duration: Date.now() - start,
  };
}
