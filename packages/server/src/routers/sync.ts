import { PUSH_PROVIDERS } from "@dofek/providers/push-providers";
import { TRPCError } from "@trpc/server";
import type { Job, Queue } from "bullmq";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { enqueueSyncJob } from "dofek/jobs/enqueue-sync-job";
import {
  createSyncQueue,
  getImportQueue,
  getProviderSyncQueue,
  IMPORT_QUEUE,
  type ImportJobData,
  providerSyncQueueName,
  type SyncJobData,
} from "dofek/jobs/queues";
import { syncWindowFromTriggerInput, syncWindowToJobData } from "dofek/jobs/sync-window";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { ProviderModel, providerTokenAuthSchema } from "dofek/providers/provider-model";
import { getAllProviders } from "dofek/providers/registry";
import { z } from "zod";
import { operationStatusOutputSchema, readOperationProgress } from "../lib/operation-progress.ts";
import { hasCurrentProviderAuthFailure } from "../lib/provider-auth-state.ts";
import { sanitizeErrorMessage } from "../lib/sanitize-error.ts";
import { SyncRepository } from "../repositories/sync-repository.ts";
import {
  adminProcedure,
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
  importTypeFromJobData,
  isJobDataForUser,
  parseJobId,
  providerIdForImportType,
  toJobId,
  UPLOAD_IMPORT_PROVIDERS,
} from "./sync-helpers.ts";

const syncProviderRowOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  authType: z.string(),
  tokenAuth: providerTokenAuthSchema.nullable(),
  authorized: z.boolean(),
  lastSyncedAt: z.string().nullable(),
  importOnly: z.boolean(),
  pushOnly: z.boolean(),
  needsReauth: z.boolean(),
  recentLogs: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      syncedAt: z.string(),
      durationMs: z.number().nullable(),
      recordCount: z.number().nullable(),
      dataType: z.string(),
      errorMessage: z.string().nullable(),
      authFailureReason: z.string().nullable(),
    }),
  ),
});

const syncDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD date")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Invalid calendar date");

export const triggerSyncInput = z
  .object({
    providerId: z.string().optional(),
    sinceDays: z.number().int().positive().optional(),
    sinceDate: syncDateSchema.optional(),
    untilDate: syncDateSchema.optional(),
  })
  .superRefine((input, ctx) => {
    const hasRange = input.sinceDate != null || input.untilDate != null;
    if (hasRange && input.sinceDays != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Use either sinceDays or sinceDate/untilDate, not both",
      });
    }
    if (input.sinceDate && !input.untilDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "untilDate is required when sinceDate is set",
      });
    }
    if (input.untilDate && !input.sinceDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sinceDate is required when untilDate is set",
      });
    }
  });

export const syncStatusInput = z.object({ jobId: z.string() });

export const logsInput = z.object({ limit: z.number().default(100) });

const providerStatsOutputSchema = z.array(
  z.object({
    providerId: z.string(),
    totalRecords: z.number().int().nonnegative(),
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

const activeImportsOutputSchema = z.array(
  operationStatusOutputSchema.extend({
    jobId: z.string(),
    providerId: z.string(),
    failedCount: z.number().optional(),
  }),
);

const importJobProgressSchema = z.union([
  z.number(),
  z.object({
    percentage: z.number().optional(),
    message: z.string().optional(),
    failedCount: z.number().optional(),
  }),
]);

const syncJobDataSchema = z.object({
  userId: z.string(),
  providerId: z.string().optional(),
  sinceDays: z.number().optional(),
  sinceIso: z.string().optional(),
  untilIso: z.string().optional(),
  targetRefreshWindow: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("full") }),
      z.object({ type: z.literal("days"), days: z.number() }),
      z.object({
        type: z.literal("range"),
        sinceIso: z.string(),
        untilIso: z.string(),
      }),
    ])
    .optional(),
  checkpoint: z.unknown().optional(),
});

const providerJobOutputSchema = z.object({
  providerId: z.string(),
  jobId: z.string(),
  queueName: z.string(),
});

const providerSyncResultSchema = z.discriminatedUnion("status", [
  z.object({
    providerId: z.string(),
    status: z.literal("started"),
    jobId: z.string(),
    queueName: z.string(),
  }),
  z.object({
    providerId: z.string(),
    status: z.literal("skippedCooldown"),
    message: z.string(),
  }),
  z.object({
    providerId: z.string(),
    status: z.literal("alreadyQueued"),
    jobId: z.string(),
    queueName: z.string(),
  }),
  z.object({
    providerId: z.string(),
    status: z.literal("failed"),
    message: z.string(),
  }),
]);

const triggerSyncOutputSchema = z.object({
  jobId: z.string().optional(),
  jobIds: z.array(z.string()),
  providerJobs: z.array(providerJobOutputSchema),
  providerResults: z.array(providerSyncResultSchema),
});

type ProviderSyncResult = z.infer<typeof providerSyncResultSchema>;

const queueBackpressureOutputSchema = z.array(
  z.object({
    queueName: z.string(),
    providerId: z.string().optional(),
    waiting: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    delayed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
);

const queueBackpressureStates = ["waiting", "active", "delayed", "failed"] as const;

export { sanitizeErrorMessage };

/** @deprecated Legacy queue for syncStatus/activeSyncs backward compat. */
const legacySyncQueue = createSyncQueue();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const syncRouterProcedures = {
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
          tokenAuth: model.tokenAuth,
          importOnly: model.importOnly,
        };
      })
      .filter((provider) => provider.importOnly || provider.authType !== "none");

    return [...UPLOAD_IMPORT_PROVIDERS, ...registeredProviders];
  }),

  /** List all providers and whether they're enabled (have valid config) */
  providers: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .output(z.array(syncProviderRowOutputSchema))
    .query(async ({ ctx }) => {
      await ensureProvidersRegistered();
      const all = getAllProviders();
      const repo = new SyncRepository(ctx.db, ctx.userId, ctx.sensorStore);

      // Batch: load connections, last sync times, recent auth errors, and stats.
      const [allConnections, lastSyncs, latestErrors, recentLogsByProvider] = await Promise.all([
        repo.getConnectedProviderIds(),
        repo.getLastSyncTimes(),
        repo.getLatestErrors(),
        repo.getRecentLogsByProvider(3),
      ]);

      const connectionSet = new Set(allConnections.map((row) => row.providerId));
      const connectionUpdatedAtMap = new Map(
        allConnections.map((row) => [row.providerId, row.updatedAt]),
      );
      const lastSyncMap = new Map(lastSyncs.map((r) => [r.providerId, r.lastSynced]));
      const authErrorProviders = new Set(
        latestErrors
          .filter((r) =>
            hasCurrentProviderAuthFailure(
              r.authFailureReason,
              r.syncedAt,
              connectionUpdatedAtMap.get(r.providerId),
            ),
          )
          .map((r) => r.providerId),
      );
      const registeredProviders = all
        .filter((p) => p.validate() === null)
        .map((p) => {
          const model = new ProviderModel(p, connectionSet, lastSyncMap, CUSTOM_AUTH_PROVIDERS);
          return {
            id: model.id,
            name: model.name,
            description: null,
            authType: model.authType,
            tokenAuth: model.tokenAuth,
            authorized: model.isConnected,
            lastSyncedAt: model.lastSyncedAt,
            importOnly: model.importOnly,
            pushOnly: false,
            needsReauth: authErrorProviders.has(model.id),
            recentLogs: recentLogsByProvider.get(model.id) ?? [],
          };
        });

      const pushProviders = PUSH_PROVIDERS.map((provider) => {
        return {
          id: provider.id,
          name: provider.name,
          description: provider.description,
          authType: provider.authType,
          tokenAuth: null,
          authorized: connectionSet.has(provider.id),
          lastSyncedAt: null,
          importOnly: false,
          pushOnly: true,
          needsReauth: false,
          recentLogs: recentLogsByProvider.get(provider.id) ?? [],
        };
      });

      return [...registeredProviders, ...pushProviders];
    }),

  /** Trigger sync — enqueues a BullMQ job, returns immediately with jobId */
  triggerSync: createTriggerSyncProcedure(),

  queueBackpressure: adminProcedure.output(queueBackpressureOutputSchema).query(async () => {
    const providerIds = new Set([
      ...getAllConfiguredProviderIds(),
      ...getAllProviders().map((p) => p.id),
    ]);
    const providerBackpressure = await Promise.all(
      [...providerIds].map(async (providerId) => {
        const counts = await getProviderSyncQueue(providerId).getJobCounts(
          ...queueBackpressureStates,
        );
        return {
          queueName: providerSyncQueueName(providerId),
          providerId,
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        };
      }),
    );
    const importCounts = await getImportQueue().getJobCounts(...queueBackpressureStates);
    return [
      ...providerBackpressure,
      {
        queueName: IMPORT_QUEUE,
        waiting: importCounts.waiting ?? 0,
        active: importCounts.active ?? 0,
        delayed: importCounts.delayed ?? 0,
        failed: importCounts.failed ?? 0,
      },
    ];
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
    } catch (error: unknown) {
      captureException(error, {
        tags: { procedure: "sync.syncStatus" },
        extra: { jobId: input.jobId },
      });
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "Sync status is temporarily unavailable. Please try again.",
        cause: error,
      });
    }
    if (!job) return null;

    // Only return status for jobs belonging to the requesting user
    const jobData = syncJobDataSchema.safeParse(job.data);
    if (!jobData.success || jobData.data.userId !== ctx.userId) return null;

    let operationProgress: Awaited<ReturnType<typeof readOperationProgress>>;
    try {
      operationProgress = await readOperationProgress(job);
    } catch (error: unknown) {
      captureException(error, {
        tags: { procedure: "sync.syncStatus" },
        extra: { jobId: input.jobId },
      });
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "Sync status is temporarily unavailable. Please try again.",
        cause: error,
      });
    }

    const progressSchema = z.object({
      providers: z
        .record(
          z.string(),
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
    if (operationProgress.status === "completed" || operationProgress.status === "failed") {
      await invalidateAllUserQueries(ctx.userId);
    }

    return {
      ...operationProgress,
      providers: progress?.providers ?? {},
      message:
        operationProgress.status === "completed" ? "Sync complete" : operationProgress.message,
    };
  }),

  /** Check for active sync jobs belonging to the current user */
  activeSyncs: protectedProcedure.query(async ({ ctx }) => {
    // Collect jobs from all per-provider queues + legacy queue
    let jobs: Job<SyncJobData>[];
    try {
      const states: Array<"active" | "waiting" | "delayed"> = ["active", "waiting", "delayed"];
      const providerIds = new Set([
        ...getAllConfiguredProviderIds(),
        ...getAllProviders().map((p) => p.id),
      ]);
      const jobArrays: Job<SyncJobData>[][] = await Promise.all([
        ...[...providerIds].map((id) => getProviderSyncQueue(id).getJobs(states)),
        legacySyncQueue.getJobs(states),
      ]);
      jobs = jobArrays.flat();
    } catch (error: unknown) {
      captureException(error, {
        tags: { procedure: "sync.activeSyncs" },
      });
      throw new TRPCError({
        code: "BAD_GATEWAY",
        message: "Active syncs are temporarily unavailable. Please try again.",
        cause: error,
      });
    }

    const progressSchema = z.object({
      providers: z
        .record(
          z.string(),
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
      status: "queued" | "running";
      percentage?: number;
      providers: Record<
        string,
        { status: "pending" | "running" | "done" | "error"; message?: string }
      >;
    }> = [];

    for (const job of jobs) {
      const jobData = syncJobDataSchema.safeParse(job.data);
      if (!jobData.success || jobData.data.userId !== ctx.userId) continue;
      const jobId = toJobId(job.id, jobData.data.providerId ?? "unknown");
      let operationProgress: Awaited<ReturnType<typeof readOperationProgress>>;
      try {
        operationProgress = await readOperationProgress(job);
      } catch (error: unknown) {
        captureException(error, {
          tags: { procedure: "sync.activeSyncs" },
          extra: { jobId },
        });
        throw new TRPCError({
          code: "BAD_GATEWAY",
          message: "Active syncs are temporarily unavailable. Please try again.",
          cause: error,
        });
      }
      if (operationProgress.status !== "queued" && operationProgress.status !== "running") {
        continue;
      }
      const parsed = progressSchema.safeParse(job.progress);
      const progress = parsed.success ? parsed.data : undefined;
      results.push({
        jobId,
        status: operationProgress.status,
        percentage: operationProgress.percentage,
        providers: progress?.providers ?? {},
      });
    }

    return results;
  }),

  /** Check for active file imports belonging to the current user. */
  activeImports: protectedProcedure.output(activeImportsOutputSchema).query(async ({ ctx }) => {
    let jobs: Job<ImportJobData>[];
    try {
      jobs = await getImportQueue().getJobs(["active", "waiting", "delayed", "waiting-children"]);
    } catch (error: unknown) {
      captureException(error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "We couldn't check import progress. Please try again.",
      });
    }

    const results: z.infer<typeof activeImportsOutputSchema> = [];
    for (const job of jobs) {
      if (!isJobDataForUser(job.data, ctx.userId)) continue;
      const importType = importTypeFromJobData(job.data);
      if (!importType) continue;
      const providerId = providerIdForImportType(importType);
      if (!providerId) continue;

      const parsedProgress = importJobProgressSchema.safeParse(job.progress);
      const progressValue = parsedProgress.success ? parsedProgress.data : undefined;
      const operationProgress = await readOperationProgress({
        failedReason: job.failedReason,
        getState: () => job.getState(),
        progress: progressValue,
      });
      const message =
        typeof progressValue === "object" && progressValue.message
          ? progressValue.message
          : operationProgress.status === "queued"
            ? "Waiting to import..."
            : "Processing import...";
      const failedCount = typeof progressValue === "object" ? progressValue.failedCount : undefined;

      results.push({
        jobId: String(job.id ?? `job-${providerId}`),
        providerId,
        ...operationProgress,
        message,
        ...(failedCount !== undefined ? { failedCount } : {}),
      });
    }

    return results;
  }),

  /** Get sync log history */
  logs: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
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
  providerStats: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
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
};

function createTriggerSyncProcedure() {
  return protectedProcedure
    .input(triggerSyncInput)
    .output(triggerSyncOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await ensureProvidersRegistered();
      return withAccountErasureUserWriteFence(ctx.db, ctx.userId, async (transaction) => {
        const repo = new SyncRepository(transaction, ctx.userId);
        const allConnections = await repo.getConnectedProviderIds();
        const connectionSet = new Set(allConnections.map((row) => row.providerId));

        const providerIds: string[] = [];

        // Validate provider exists and is configured before enqueuing.
        // For "sync all", fan out into one BullMQ job per connected provider.
        if (input.providerId) {
          const provider = getAllProviders().find(
            (registeredProvider) => registeredProvider.id === input.providerId,
          );
          if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
          const validation = provider.validate();
          if (validation) throw new Error(`Provider not configured: ${validation}`);
          const model = new ProviderModel(
            provider,
            connectionSet,
            undefined,
            CUSTOM_AUTH_PROVIDERS,
          );
          if (!model.isConnected) {
            throw new Error(`Provider not connected: ${provider.id}`);
          }
          providerIds.push(provider.id);
        } else {
          for (const provider of getAllProviders()) {
            if (provider.validate() !== null) continue;
            const model = new ProviderModel(
              provider,
              connectionSet,
              undefined,
              CUSTOM_AUTH_PROVIDERS,
            );
            if (model.importOnly || !model.isConnected) continue;
            providerIds.push(model.id);
          }

          if (providerIds.length === 0)
            throw new Error("No configured providers available for sync");
        }

        const syncWindow = syncWindowFromTriggerInput({
          sinceDays: input.sinceDays,
          sinceDate: input.sinceDate,
          untilDate: input.untilDate,
        });

        const providerResults = await Promise.all(
          providerIds.map(async (providerId): Promise<ProviderSyncResult> => {
            try {
              const job = await enqueueSyncJob(
                providerId,
                {
                  providerId,
                  userId: ctx.userId,
                  ...syncWindowToJobData(syncWindow, input.sinceDays),
                },
                { skipWhenRateLimited: true, singleFlightFullSync: true },
              );
              if (!job) {
                return {
                  providerId,
                  status: "skippedCooldown",
                  message: "Provider sync skipped: rate-limit cooldown active",
                };
              }
              const jobId = toJobId(job.id, providerId);
              return {
                providerId,
                status: job.alreadyQueued ? "alreadyQueued" : "started",
                jobId,
                queueName: providerSyncQueueName(providerId),
              };
            } catch (error: unknown) {
              captureException(error);
              return {
                providerId,
                status: "failed",
                message: errorMessage(error),
              };
            }
          }),
        );

        const providerJobs = providerResults.flatMap((providerResult) => {
          if (providerResult.status !== "started" && providerResult.status !== "alreadyQueued") {
            return [];
          }
          return [
            {
              providerId: providerResult.providerId,
              jobId: providerResult.jobId,
              queueName: providerResult.queueName,
            },
          ];
        });

        return {
          jobId: providerJobs[0]?.jobId,
          jobIds: providerJobs.map((job) => job.jobId),
          providerJobs,
          providerResults,
        };
      });
    });
}

export const syncRouter = router({
  ...syncRouterProcedures,
  triggerSync: createTriggerSyncProcedure(),
});
