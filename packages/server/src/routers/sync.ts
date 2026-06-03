import { TRPCError } from "@trpc/server";
import type { Job, Queue } from "bullmq";
import {
  createSyncQueue,
  getProviderSyncQueue,
  providerSyncQueueName,
  SYNC_JOB_RETRY_OPTIONS,
  type SyncJobData,
} from "dofek/jobs/queues";
import { queryCache } from "dofek/lib/cache";
import { ProviderModel } from "dofek/providers/provider-model";
import { getAllProviders } from "dofek/providers/registry";
import { sql as sqlTag } from "drizzle-orm";
import { z } from "zod";
import { hasCurrentProviderAuthFailure } from "../lib/provider-auth-state.ts";
import { startWorker } from "../lib/start-worker.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { SyncRepository } from "../repositories/sync-repository.ts";
import {
  CacheTTL,
  cachedProtectedQuery,
  protectedProcedure,
  publicProcedure,
  router,
} from "../trpc.ts";
import {
  CUSTOM_AUTH_PROVIDERS,
  ensureProvidersRegistered,
  getAllConfiguredProviderIds,
  mapBullMqStateToSyncStatus,
  parseJobId,
  resolveSinceIso,
  resolveTargetRefreshWindow,
  toJobId,
  UPLOAD_IMPORT_PROVIDERS,
} from "./sync-helpers.ts";

// ── Input schemas ──
export const triggerSyncInput = z.object({
  providerId: z.string().optional(),
  sinceDays: z.number().optional(),
});

export const syncStatusInput = z.object({ jobId: z.string() });

export const logsInput = z.object({ limit: z.number().default(100) });

const providerStatsOutputSchema = z.array(
  z.object({
    providerId: z.string(),
    activities: z.number().int().nonnegative(),
    dailyMetrics: z.number().int().nonnegative(),
    sleepSessions: z.number().int().nonnegative(),
    bodyMeasurements: z.number().int().nonnegative(),
    foodEntries: z.number().int().nonnegative(),
    healthEvents: z.number().int().nonnegative(),
    metricStream: z.number().int().nonnegative(),
    nutritionDaily: z.number().int().nonnegative(),
    labPanels: z.number().int().nonnegative(),
    labResults: z.number().int().nonnegative(),
    journalEntries: z.number().int().nonnegative(),
  }),
);

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

/** @deprecated Legacy queue for syncStatus/activeSyncs backward compat. */
const legacySyncQueue = createSyncQueue();

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
    const tokenUpdatedAtMap = new Map(allTokens.map((r) => [r.providerId, r.updatedAt]));
    const lastSyncMap = new Map(lastSyncs.map((r) => [r.providerId, r.lastSynced]));
    const authErrorProviders = new Set(
      latestErrors
        .filter((r) =>
          hasCurrentProviderAuthFailure(
            r.authFailureReason,
            r.syncedAt,
            tokenUpdatedAtMap.get(r.providerId),
          ),
        )
        .map((r) => r.providerId),
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
          needsReauth: authErrorProviders.has(model.id),
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
    const configuredIds = getAllConfiguredProviderIds();
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
    // ClickHouse read models update outside the API server, but the API
    // server's in-memory cache can still hold stale results until TTL expiry.
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
        ...[...getAllConfiguredProviderIds()].map((id) => getProviderSyncQueue(id).getJobs(states)),
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
  providerStats: cachedProtectedQuery(CacheTTL.SHORT)
    .output(providerStatsOutputSchema)
    .query(async ({ ctx }) => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "sync.providerStats requires the ClickHouse provider stats store. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new SyncRepository(ctx.db, ctx.userId, ctx.sensorStore);
      return repo.getProviderStats();
    }),

  /** Diagnostic: row counts for primary user-owned raw tables. */
  dataHealth: protectedProcedure.query(async ({ ctx }) => {
    const countSchema = z.object({ count: z.coerce.number() });

    const healthChecks = [
      { key: "dailyMetrics", table: "fitness.daily_metrics" },
      { key: "sleep", table: "fitness.sleep_session" },
      { key: "activity", table: "fitness.activity" },
    ] as const;

    const counts = await Promise.all(
      healthChecks.map(({ table }) =>
        executeWithSchema(
          ctx.db,
          countSchema,
          sqlTag`SELECT count(*)::int AS count FROM ${sqlTag.raw(table)} WHERE user_id = ${ctx.userId}`,
        ),
      ),
    );

    const health: Record<string, number> = {};
    for (const [index, { key }] of healthChecks.entries()) {
      health[key] = counts[index]?.[0]?.count ?? 0;
    }

    return health;
  }),
});
