import type { Job } from "bullmq";
import { Worker } from "bullmq";
import { createDatabaseFromEnv } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import {
  getRedisConnection,
  IMPORT_QUEUE,
  type ImportJobData,
  SYNC_QUEUE,
  type SyncJobData,
} from "./queues.ts";

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const db = createDatabaseFromEnv();
const connection = getRedisConnection();

// ── Sync job processor ──

async function processSyncJob(job: Job<SyncJobData>): Promise<void> {
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

// ── Import job processor ──

async function processImportJob(job: Job<ImportJobData>): Promise<void> {
  const { filePath, since, userId, importType, weightUnit } = job.data;
  const sinceDate = new Date(since);
  const importStart = Date.now();

  try {
    if (importType === "apple-health") {
      const { importAppleHealthFile } = await import("../providers/apple-health.ts");
      let lastLoggedPct = 0;
      const result = await importAppleHealthFile(db, filePath, sinceDate, (info) => {
        job.updateProgress({ pct: info.pct, message: `Processing: ${info.pct}%` });
        if (info.pct >= lastLoggedPct + 10) {
          console.log(`[worker] Apple Health import progress: ${info.pct}%`);
          lastLoggedPct = info.pct;
        }
      });

      const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
      const msg = `${result.recordsSynced} records imported, ${result.errors?.length ?? 0} errors in ${durationSec}s`;
      console.log(`[worker] Apple Health import complete: ${msg}`);

      await logSync(db, {
        providerId: "apple_health",
        dataType: "import",
        status: result.errors?.length ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: result.errors?.length
          ? result.errors.map((e) => e.message).join("; ")
          : undefined,
        durationMs: Date.now() - importStart,
      });
    } else if (importType === "strong-csv") {
      const { readFile } = await import("node:fs/promises");
      const csvText = await readFile(filePath, "utf-8");
      const { importStrongCsv } = await import("../providers/strong-csv.ts");
      const result = await importStrongCsv(db, csvText, userId, weightUnit ?? "kg");

      const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
      const msg = `${result.recordsSynced} workouts imported, ${result.errors.length} errors in ${durationSec}s`;
      console.log(`[worker] Strong CSV import complete: ${msg}`);

      await logSync(db, {
        providerId: "strong-csv",
        dataType: "import",
        status: result.errors.length ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: result.errors.length
          ? result.errors.map((e) => e.message).join("; ")
          : undefined,
        durationMs: Date.now() - importStart,
      });
    } else if (importType === "cronometer-csv") {
      const { readFile } = await import("node:fs/promises");
      const csvText = await readFile(filePath, "utf-8");
      const { importCronometerCsv } = await import("../providers/cronometer-csv.ts");
      const result = await importCronometerCsv(db, csvText, userId);

      const durationSec = ((Date.now() - importStart) / 1000).toFixed(1);
      const msg = `${result.recordsSynced} food entries imported, ${result.errors.length} errors in ${durationSec}s`;
      console.log(`[worker] Cronometer CSV import complete: ${msg}`);

      await logSync(db, {
        providerId: "cronometer-csv",
        dataType: "import",
        status: result.errors.length ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: result.errors.length
          ? result.errors.map((e: { message: string }) => e.message).join("; ")
          : undefined,
        durationMs: Date.now() - importStart,
      });
    }
  } finally {
    // Clean up uploaded file
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath).catch(() => {});
  }

  // Post-import: refresh views
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

// ── Workers ──

const syncWorker = new Worker<SyncJobData>(SYNC_QUEUE, processSyncJob, { connection });
const importWorker = new Worker<ImportJobData>(IMPORT_QUEUE, processImportJob, { connection });

// ── Idle spin-down ──

let idleTimer: NodeJS.Timeout | null = null;
let activeJobs = 0;

function resetIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function startIdleTimer() {
  resetIdleTimer();
  idleTimer = setTimeout(async () => {
    console.log("[worker] Idle timeout reached, shutting down...");
    await shutdown();
  }, IDLE_TIMEOUT_MS);
}

for (const worker of [syncWorker, importWorker]) {
  worker.on("active", () => {
    activeJobs++;
    resetIdleTimer();
  });

  worker.on("completed", () => {
    activeJobs--;
    if (activeJobs <= 0) startIdleTimer();
  });

  worker.on("failed", (_job, err) => {
    activeJobs--;
    console.error(`[worker] Job failed: ${err.message}`);
    if (activeJobs <= 0) startIdleTimer();
  });

  worker.on("error", (err) => {
    console.error(`[worker] Worker error: ${err.message}`);
  });
}

// Start idle timer immediately (exit if no jobs arrive within timeout)
startIdleTimer();

// ── Graceful shutdown ──

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[worker] Shutting down gracefully...");
  await Promise.all([syncWorker.close(), importWorker.close()]);
  console.log("[worker] Shutdown complete.");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log("[worker] Started, waiting for jobs...");
