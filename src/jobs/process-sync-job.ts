import type { SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { SyncJobData } from "./queues.ts";

/** Minimal Job interface — only the subset processSyncJob actually uses. */
interface SyncJob {
  data: SyncJobData;
  updateProgress: (data: object) => Promise<void>;
}

export async function processSyncJob(job: SyncJob, db: SyncDatabase): Promise<void> {
  const { providerId, sinceDays } = job.data;
  const since = sinceDays ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000) : new Date(0);

  // Lazy-import provider registration
  const { ensureProvidersRegistered } = await import("./provider-registration.ts");
  await ensureProvidersRegistered();

  const { getAllProviders } = await import("../providers/index.ts");

  let providers = getAllProviders().filter((p) => p.validate() === null);
  if (providerId) {
    const specific = providers.find((p) => p.id === providerId);
    if (!specific) throw new Error(`Unknown provider: ${providerId}`);
    providers = [specific];
  }

  const providerStatus: Record<string, { status: string; message?: string }> = {};
  for (const p of providers) {
    providerStatus[p.id] = { status: "pending" };
  }
  await job.updateProgress({ providers: providerStatus });

  for (const provider of providers) {
    providerStatus[provider.id] = { status: "running" };
    await job.updateProgress({ providers: providerStatus });

    await ensureProvider(db, provider.id, provider.name);
    const syncStart = Date.now();

    try {
      console.log(`[worker] Starting ${provider.name}...`);
      const result = await provider.sync(db, since);
      const hasErrors = result.errors.length > 0;
      const parts = [`${result.recordsSynced} synced`];
      if (hasErrors) parts.push(`${result.errors.length} errors`);

      providerStatus[provider.id] = {
        status: hasErrors ? "error" : "done",
        message: parts.join(", "),
      };
      await job.updateProgress({ providers: providerStatus });

      await logSync(db, {
        providerId: provider.id,
        dataType: "sync",
        status: hasErrors ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: hasErrors ? result.errors.map((e) => e.message).join("; ") : undefined,
        durationMs: Date.now() - syncStart,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      providerStatus[provider.id] = { status: "error", message };
      await job.updateProgress({ providers: providerStatus });

      await logSync(db, {
        providerId: provider.id,
        dataType: "sync",
        status: "error",
        errorMessage: message,
        durationMs: Date.now() - syncStart,
      });
    }
  }

  // Post-sync: update max HR + refresh views
  try {
    const { updateUserMaxHr } = await import("../db/dedup.ts");
    await updateUserMaxHr(db);
  } catch (err) {
    console.error(`[worker] Failed to update max HR: ${err}`);
  }

  try {
    const { refreshDedupViews } = await import("../db/dedup.ts");
    await refreshDedupViews(db);
  } catch (err) {
    console.error(`[worker] Failed to refresh views: ${err}`);
  }
}
