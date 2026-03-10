import type { Database } from "../db/index.js";
import type { Provider, SyncResult } from "../providers/types.js";
import { getEnabledProviders } from "../providers/index.js";

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
  db: Database,
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

  const settled: SyncResult[] = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      provider: toSync[i].id,
      recordsSynced: 0,
      errors: [{ message: String(r.reason) }],
      duration: 0,
    };
  });

  return {
    results: settled,
    totalRecords: settled.reduce((sum, r) => sum + r.recordsSynced, 0),
    totalErrors: settled.reduce((sum, r) => sum + r.errors.length, 0),
    duration: Date.now() - start,
  };
}
