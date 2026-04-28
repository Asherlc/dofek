import type { Job, Queue } from "bullmq";
import { getConfiguredProviderIds } from "dofek/jobs/provider-queue-config";
import {
  createSyncQueue,
  getProviderSyncQueue,
  providerSyncQueueName,
  SYNC_JOB_RETRY_OPTIONS,
  type SyncJobData,
} from "dofek/jobs/queues";
import { queryCache } from "dofek/lib/cache";
import { ProviderModel } from "dofek/providers/provider-model";
import { getAllProviders, registerProvider } from "dofek/providers/registry";
import { sql as sqlTag } from "drizzle-orm";
import { z } from "zod";
import { startWorker } from "../lib/start-worker.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { SyncRepository } from "../repositories/sync-repository.ts";
import {
  CacheTTL,
  cachedProtectedQuery,
  protectedProcedure,
  publicProcedure,
  router,
} from "../trpc.ts";

const AUTH_ERROR_PATTERNS = [
  /\bauthorization failed\b/i,
  // Match standalone "unauthorized" text while avoiding JSON payload fragments
  // like {"error":"unauthorized"} that are often endpoint-specific failures.
  /(?:^|[\s[(])unauthorized(?:$|[\s):\]])/i,
  /\bre-authenticate\b/i,
  /\btoken expired\b/i,
  /\bsession expired\b/i,
  /\bauthentication failed\b/i,
] as const;

const CUSTOM_AUTH_PROVIDERS: Record<string, string> = {
  whoop: "custom:whoop",
  garmin: "custom:garmin",
};

const UPLOAD_IMPORT_PROVIDERS = [
  {
    id: "apple_health",
    name: "Apple Health",
    authType: "file-import",
    importOnly: true,
  },
] as const;

/**
 * Check if a sync error message indicates an authentication/authorization failure
 * that requires the user to re-connect the provider.
 */
export function isAuthError(errorMessage: string | null): boolean {
  if (!errorMessage) return false;
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage));
}

// ── Input schemas ──
export const triggerSyncInput = z.object({
  providerId: z.string().optional(),
  sinceDays: z.number().optional(),
});

export const syncStatusInput = z.object({ jobId: z.string() });

export const logsInput = z.object({ limit: z.number().default(100) });

const syncJobDataSchema = z.object({
  userId: z.string(),
  providerId: z.string().optional(),
  sinceDays: z.number().optional(),
  sinceIso: z.string().optional(),
  targetRefreshWindow: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("full") }),
      z.object({ type: z.literal("days"), days: z.number() }),
    ])
    .optional(),
  checkpoint: z.unknown().optional(),
});

import { sanitizeErrorMessage } from "../lib/sanitize-error.ts";
export { sanitizeErrorMessage };

export function toJobId(id: string | number | undefined, providerId: string): string {
  return id === undefined ? `job-${providerId}-${Date.now()}` : `${providerId}:${id}`;
}

/** Parse a composite jobId into its provider hint and raw BullMQ ID.
 *  New format: "providerId:rawId", where rawId may be numeric or non-numeric.
 *  Legacy format: plain raw ID string. */
export function parseJobId(compositeId: string): { providerId: string | null; rawId: string } {
  const colonIndex = compositeId.indexOf(":");
  if (colonIndex > 0) {
    return {
      providerId: compositeId.slice(0, colonIndex),
      rawId: compositeId.slice(colonIndex + 1),
    };
  }
  return { providerId: null, rawId: compositeId };
}

function resolveSinceIso(sinceDays?: number): string {
  return sinceDays
    ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
    : new Date(0).toISOString();
}

function resolveTargetRefreshWindow(sinceDays?: number): SyncJobData["targetRefreshWindow"] {
  return sinceDays ? { type: "days", days: sinceDays } : { type: "full" };
}

// ── Provider registration (race-safe) ──
let registrationPromise: Promise<void> | null = null;

export function ensureProvidersRegistered(): Promise<void> {
  if (!registrationPromise) {
    registrationPromise = doRegisterProviders();
  }
  return registrationPromise;
}

async function doRegisterProviders() {
  const providers = [
    ["wahoo", () => import("dofek/providers/wahoo/provider").then((m) => new m.WahooProvider())],
    ["withings", () => import("dofek/providers/withings").then((m) => new m.WithingsProvider())],
    ["peloton", () => import("dofek/providers/peloton").then((m) => new m.PelotonProvider())],
    ["fatsecret", () => import("dofek/providers/fatsecret").then((m) => new m.FatSecretProvider())],
    ["whoop", () => import("dofek/providers/whoop").then((m) => new m.WhoopProvider())],
    [
      "ride-with-gps",
      () => import("dofek/providers/ride-with-gps").then((m) => new m.RideWithGpsProvider()),
    ],
    [
      "strong-csv",
      () => import("dofek/providers/strong-csv").then((m) => new m.StrongCsvProvider()),
    ],
    ["polar", () => import("dofek/providers/polar").then((m) => new m.PolarProvider())],
    ["fitbit", () => import("dofek/providers/fitbit").then((m) => new m.FitbitProvider())],
    ["garmin", () => import("dofek/providers/garmin").then((m) => new m.GarminProvider())],
    ["strava", () => import("dofek/providers/strava").then((m) => new m.StravaProvider())],
    [
      "cronometer-csv",
      () => import("dofek/providers/cronometer-csv").then((m) => new m.CronometerCsvProvider()),
    ],
    ["oura", () => import("dofek/providers/oura").then((m) => new m.OuraProvider())],
    ["bodyspec", () => import("dofek/providers/bodyspec").then((m) => new m.BodySpecProvider())],
    [
      "eight-sleep",
      () => import("dofek/providers/eight-sleep").then((m) => new m.EightSleepProvider()),
    ],
    ["zwift", () => import("dofek/providers/zwift").then((m) => new m.ZwiftProvider())],
    [
      "trainerroad",
      () => import("dofek/providers/trainerroad").then((m) => new m.TrainerRoadProvider()),
    ],
    [
      "ultrahuman",
      () => import("dofek/providers/ultrahuman").then((m) => new m.UltrahumanProvider()),
    ],
    [
      "mapmyfitness",
      () => import("dofek/providers/mapmyfitness").then((m) => new m.MapMyFitnessProvider()),
    ],
    ["suunto", () => import("dofek/providers/suunto").then((m) => new m.SuuntoProvider())],
    ["coros", () => import("dofek/providers/coros").then((m) => new m.CorosProvider())],
    ["concept2", () => import("dofek/providers/concept2").then((m) => new m.Concept2Provider())],
    ["komoot", () => import("dofek/providers/komoot").then((m) => new m.KomootProvider())],
    ["xert", () => import("dofek/providers/xert").then((m) => new m.XertProvider())],
    [
      "cycling-analytics",
      () =>
        import("dofek/providers/cycling-analytics").then((m) => new m.CyclingAnalyticsProvider()),
    ],
    ["wger", () => import("dofek/providers/wger").then((m) => new m.WgerProvider())],
    ["decathlon", () => import("dofek/providers/decathlon").then((m) => new m.DecathlonProvider())],
    ["velohero", () => import("dofek/providers/velohero").then((m) => new m.VeloHeroProvider())],
    [
      "auto-supplements",
      () => import("dofek/providers/auto-supplements").then((m) => new m.AutoSupplementsProvider()),
    ],
  ] as const;

  for (const [name, loadProvider] of providers) {
    try {
      registerProvider(await loadProvider());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to register ${name} provider: ${message}`);
    }
  }
}

/** @deprecated Legacy queue for syncStatus/activeSyncs backward compat. */
const legacySyncQueue = createSyncQueue();

/** Map BullMQ job state to the frontend SyncJobStatus shape */
export function mapBullMqStateToSyncStatus(state: string): "running" | "done" | "error" {
  switch (state) {
    case "completed":
      return "done";
    case "failed":
      return "error";
    default:
      return "running";
  }
}

export const syncRouter = router({
  /** Public list of configured providers that have a user-facing connection or import flow. */
  usableProviders: publicProcedure.query(async () => {
    await ensureProvidersRegistered();

    const registeredProviders = getAllProviders()
      .filter((provider) => provider.validate() === null)
      .map((provider) => {
        const model = new ProviderModel(provider, new Set(), undefined, CUSTOM_AUTH_PROVIDERS);
        return {
          id: model.id,
          name: model.name,
          authType: model.authType,
          importOnly: model.importOnly,
        };
      })
      .filter((provider) => provider.importOnly || provider.authType !== "none");

    return [...UPLOAD_IMPORT_PROVIDERS, ...registeredProviders];
  }),

  /** List all providers and whether they're enabled (have valid config) */
  providers: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    await ensureProvidersRegistered();
    const all = getAllProviders();
    const repo = new SyncRepository(ctx.db, ctx.userId);

    // Batch: load all tokens, last sync times, and recent auth errors in 3 queries instead of 3N
    const [allTokens, lastSyncs, latestErrors] = await Promise.all([
      repo.getConnectedProviderIds(),
      repo.getLastSyncTimes(),
      repo.getLatestErrors(),
    ]);

    const tokenSet = new Set(allTokens.map((r) => r.providerId));
    const lastSyncMap = new Map(lastSyncs.map((r) => [r.providerId, r.lastSynced]));
    const authErrorProviders = new Set(
      latestErrors.filter((r) => isAuthError(r.errorMessage)).map((r) => r.providerId),
    );

    return all
      .filter((p) => p.validate() === null)
      .map((p) => {
        const model = new ProviderModel(p, tokenSet, lastSyncMap, CUSTOM_AUTH_PROVIDERS);
        return {
          id: model.id,
          name: model.name,
          authType: model.authType,
          authorized: model.isConnected,
          lastSyncedAt: model.lastSyncedAt,
          importOnly: model.importOnly,
          needsReauth: model.isConnected && authErrorProviders.has(model.id),
        };
      });
  }),

  /** Trigger sync — enqueues a BullMQ job, returns immediately with jobId */
  triggerSync: protectedProcedure.input(triggerSyncInput).mutation(async ({ ctx, input }) => {
    await ensureProvidersRegistered();
    const repo = new SyncRepository(ctx.db, ctx.userId);

    const providerIds: string[] = [];

    // Validate provider exists and is configured before enqueuing.
    // For "sync all", fan out into one BullMQ job per connected provider.
    if (input.providerId) {
      const provider = getAllProviders().find((p) => p.id === input.providerId);
      if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
      const validation = provider.validate();
      if (validation) throw new Error(`Provider not configured: ${validation}`);
      providerIds.push(provider.id);
    } else {
      // Check which providers have tokens to determine connectivity
      const allTokens = await repo.getConnectedProviderIds();
      const tokenSet = new Set(allTokens.map((r) => r.providerId));

      for (const provider of getAllProviders()) {
        if (provider.validate() !== null) continue;
        const model = new ProviderModel(provider, tokenSet);
        if (model.importOnly || !model.isConnected) continue;
        providerIds.push(model.id);
      }

      if (providerIds.length === 0) throw new Error("No configured providers available for sync");
    }

    const providerJobs = await Promise.all(
      providerIds.map(async (providerId) => {
        const queue = getProviderSyncQueue(providerId);
        const job = await queue.add(
          "sync",
          {
            providerId,
            sinceDays: input.sinceDays,
            sinceIso: resolveSinceIso(input.sinceDays),
            targetRefreshWindow: resolveTargetRefreshWindow(input.sinceDays),
            userId: ctx.userId,
          },
          SYNC_JOB_RETRY_OPTIONS,
        );
        const jobId = toJobId(job.id, providerId);
        return {
          providerId,
          jobId,
          queueName: providerSyncQueueName(providerId),
        };
      }),
    );

    startWorker();
    return {
      jobId: providerJobs[0]?.jobId ?? `job-${Date.now()}`,
      jobIds: providerJobs.map((job) => job.jobId),
      providerJobs,
    };
  }),

  /** Poll sync job status — reads from BullMQ */
  syncStatus: protectedProcedure.input(syncStatusInput).query(async ({ ctx, input }) => {
    if (!input.jobId) return null;

    const { providerId: hintProviderId, rawId } = parseJobId(input.jobId);

    // Search the hinted provider queue first (only if configured), then fall back to all queues
    const configuredIds = new Set(getConfiguredProviderIds());
    let job: Awaited<ReturnType<Queue<SyncJobData>["getJob"]>> | undefined;
    try {
      if (hintProviderId && configuredIds.has(hintProviderId)) {
        job = await getProviderSyncQueue(hintProviderId).getJob(rawId);
      } else {
        for (const providerId of configuredIds) {
          job = await getProviderSyncQueue(providerId).getJob(rawId);
          if (job) break;
        }
      }
      // Fall back to legacy queue for old jobs
      if (!job) {
        job = await legacySyncQueue.getJob(rawId);
      }
    } catch {
      return null; // Redis unavailable
    }
    if (!job) return null;

    // Only return status for jobs belonging to the requesting user
    const jobData = syncJobDataSchema.safeParse(job.data);
    if (!jobData.success || jobData.data.userId !== ctx.userId) return null;

    const state = await job.getState();

    const progressSchema = z.object({
      providers: z
        .record(
          z.object({
            status: z.enum(["pending", "running", "done", "error"]),
            message: z.string().optional(),
          }),
        )
        .optional(),
      percentage: z.number().optional(),
    });
    const parsed = progressSchema.safeParse(job.progress);
    const progress = parsed.success ? parsed.data : undefined;

    // When a sync job finishes, invalidate ALL cached data for this user.
    // The sync worker (separate process) refreshes materialized views after
    // ingesting new data, but the API server's in-memory cache still holds
    // stale results. Without full invalidation, data queries (sleep.list,
    // dailyMetrics.list, etc.) serve cached pre-sync results until TTL expiry.
    if (state === "completed" || state === "failed") {
      await queryCache.invalidateByPrefix(`${ctx.userId}:`);
    }

    return {
      status: mapBullMqStateToSyncStatus(state),
      providers: progress?.providers ?? {},
      percentage: progress?.percentage,
      message:
        state === "failed" ? job.failedReason : state === "completed" ? "Sync complete" : undefined,
    };
  }),

  /** Check for active sync jobs belonging to the current user */
  activeSyncs: protectedProcedure.query(async ({ ctx }) => {
    // Collect jobs from all per-provider queues + legacy queue
    let jobs: Job<SyncJobData>[];
    try {
      const states: Array<"active" | "waiting" | "delayed"> = ["active", "waiting", "delayed"];
      const jobArrays: Job<SyncJobData>[][] = await Promise.all([
        ...getConfiguredProviderIds().map((id) => getProviderSyncQueue(id).getJobs(states)),
        legacySyncQueue.getJobs(states),
      ]);
      jobs = jobArrays.flat();
    } catch {
      return []; // Redis unavailable
    }

    const progressSchema = z.object({
      providers: z
        .record(
          z.object({
            status: z.enum(["pending", "running", "done", "error"]),
            message: z.string().optional(),
          }),
        )
        .optional(),
      percentage: z.number().optional(),
    });

    const results: Array<{
      jobId: string;
      status: "running" | "done" | "error";
      percentage?: number;
      providers: Record<
        string,
        { status: "pending" | "running" | "done" | "error"; message?: string }
      >;
    }> = [];

    for (const job of jobs) {
      const jobData = syncJobDataSchema.safeParse(job.data);
      if (!jobData.success || jobData.data.userId !== ctx.userId) continue;
      const state = await job.getState();
      const parsed = progressSchema.safeParse(job.progress);
      const progress = parsed.success ? parsed.data : undefined;
      results.push({
        jobId: toJobId(job.id, jobData.data.providerId ?? "unknown"),
        status: mapBullMqStateToSyncStatus(state),
        percentage: progress?.percentage,
        providers: progress?.providers ?? {},
      });
    }

    return results;
  }),

  /** Get sync log history */
  logs: cachedProtectedQuery(CacheTTL.SHORT)
    .input(logsInput)
    .query(async ({ ctx, input }) => {
      const repo = new SyncRepository(ctx.db, ctx.userId);
      const rows = await repo.getLogs(input.limit);

      return rows.map((row) => ({
        ...row,
        errorMessage: sanitizeErrorMessage(row.errorMessage),
      }));
    }),

  /** Per-provider record counts broken down by table */
  providerStats: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const repo = new SyncRepository(ctx.db, ctx.userId);
    return repo.getProviderStats();
  }),

  /** Diagnostic: compare materialized view row counts vs base table row counts.
   *  Helps identify when views are empty/stale but base tables have data. */
  dataHealth: protectedProcedure.query(async ({ ctx }) => {
    const countSchema = z.object({ count: z.coerce.number() });

    const healthChecks = [
      { key: "dailyMetrics", baseTable: "fitness.daily_metrics", view: "fitness.v_daily_metrics" },
      { key: "sleep", baseTable: "fitness.sleep_session", view: "fitness.v_sleep" },
      { key: "activity", baseTable: "fitness.activity", view: "fitness.v_activity" },
    ] as const;

    const countTargets = healthChecks.flatMap(({ key, baseTable, view }) => [
      { key, target: "baseTable" as const, table: baseTable },
      { key, target: "materializedView" as const, table: view },
    ]);

    const counts = await Promise.all(
      countTargets.map(({ table }) =>
        executeWithSchema(
          ctx.db,
          countSchema,
          sqlTag`SELECT count(*)::int AS count FROM ${sqlTag.raw(table)} WHERE user_id = ${ctx.userId}`,
        ),
      ),
    );

    const health: Record<string, { baseTable: number; materializedView: number }> = {};
    for (const [index, { key, target }] of countTargets.entries()) {
      if (!health[key]) health[key] = { baseTable: 0, materializedView: 0 };
      health[key][target] = counts[index]?.[0]?.count ?? 0;
    }

    const hasStaleViews = Object.values(health).some(
      (table) => table.baseTable > 0 && table.materializedView === 0,
    );

    if (hasStaleViews) {
      logger.warn(
        `[data-health] User ${ctx.userId} has stale materialized views: ${JSON.stringify(health)}`,
      );
    }

    return { ...health, hasStaleViews };
  }),
});
