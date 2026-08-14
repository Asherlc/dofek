import { isCyclingActivity } from "@dofek/training/training";
import { TRPCError } from "@trpc/server";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { isRelationMissingError } from "dofek/db/dedup";
import {
  enqueueActivityDeleteAnalyticsRefresh,
  enqueueActivityRecomputeAnalyticsRefresh,
  enqueueActivityRestoreAnalyticsRefresh,
} from "dofek/jobs/queues";
import { queryCache } from "dofek/lib/cache";
import { getProvider } from "dofek/providers/registry";
import { z } from "zod";
import {
  ChartRange,
  selectedChartCustomRangeQuery,
  selectedChartRangeSchema,
} from "../lib/chart-range.ts";
import { endDateSchema } from "../lib/date-window.ts";
import { Activity, type ActivityDetail } from "../models/activity.ts";
import {
  ActivityRepository,
  StreamPoint as StreamPointModel,
} from "../repositories/activity-repository.ts";
import { HangboardingRepository } from "../repositories/hangboarding-repository.ts";
import { PowerRepository } from "../repositories/power-repository.ts";
import { StrengthRepository } from "../repositories/strength-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync-helpers.ts";

const MAX_BULK_DELETE_ACTIVITY_IDS = 500;

async function invalidateActivityListCaches(userId: string): Promise<void> {
  await Promise.allSettled([
    queryCache.invalidateByPrefix(`${userId}:activity.`),
    queryCache.invalidateByPrefix(`${userId}:calendar.`),
  ]);
}

async function scheduleActivityAnalyticsRefresh(
  userId: string,
  memberActivityIds: string[],
): Promise<void> {
  try {
    await enqueueActivityDeleteAnalyticsRefresh(userId, memberActivityIds);
  } catch (error) {
    const { captureException } = await import("@sentry/node");
    captureException(error, {
      tags: { phase: "activity-delete-analytics-enqueue" },
      extra: { userId, activityCount: memberActivityIds.length },
    });
  }
}

async function scheduleActivityRestoreAnalyticsRefresh(
  userId: string,
  activityIds: string[],
): Promise<void> {
  try {
    await enqueueActivityRestoreAnalyticsRefresh(userId, activityIds);
  } catch (error) {
    const { captureException } = await import("@sentry/node");
    captureException(error, {
      tags: { phase: "activity-restore-analytics-enqueue" },
      extra: { userId, activityCount: activityIds.length },
    });
  }
}

async function scheduleActivityRecomputeAnalyticsRefresh(
  userId: string,
  activityIds: string[],
): Promise<void> {
  await enqueueActivityRecomputeAnalyticsRefresh(userId, activityIds);
}

export interface StrengthExerciseDetail {
  exerciseIndex: number;
  exerciseName: string;
  equipment: string | null;
  muscleGroups: string[] | null;
  exerciseType: string | null;
  sets: import("../repositories/strength-repository.ts").SetDetail[];
}

export interface StreamPoint {
  recordedAt: string;
  heartRate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
  lat: number | null;
  lng: number | null;
}

export type ActivityHrZones = import("@dofek/zones/zones").ActivityHrZone[];

export interface ActivityPowerZonesResult {
  zones: import("@dofek/zones/zones").ActivityPowerZone[];
  ftp: number;
}

export const activityRouter = router({
  list: selectedChartCustomRangeQuery(
    "activity.list",
    CacheTTL.MEDIUM,
    z.object({
      days: selectedChartRangeSchema("activity.list"),
      endDate: endDateSchema,
      limit: z.number().min(1).max(100).default(20),
      offset: z.number().min(0).default(0),
      activityTypes: z.array(z.string()).optional(),
    }),
    async ({ ctx, input }) => {
      const repo = new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      try {
        return await repo.list(input);
      } catch (error) {
        if (isRelationMissingError(error)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
          });
        }
        throw error;
      }
    },
  ),

  byId: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ id: z.guid() }))
    .query(async ({ ctx, input }): Promise<ActivityDetail> => {
      const repo = new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const row = await repo.findById(input.id);

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
      }

      await ensureProvidersRegistered();
      return new Activity(row, getProvider).toDetail();
    }),

  hangboardDetails: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ id: z.guid() }))
    .query(async ({ ctx, input }) => {
      const repository = new HangboardingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      );
      const detail = await repository.getDetail(input.id);
      if (!detail) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Hangboarding details not found",
        });
      }
      return detail;
    }),

  stream: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(
      z.object({
        id: z.guid(),
        maxPoints: z.number().int().min(10).max(10000).default(500),
      }),
    )
    .query(async ({ ctx, input }): Promise<StreamPoint[]> => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for activity streams. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const points = await repo.getStream(input.id, input.maxPoints);
      return points.map((point) => point.toDetail());
    }),

  hrZones: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ id: z.guid() }))
    .query(async ({ ctx, input }): Promise<ActivityHrZones> => {
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for heart-rate zones. Set CLICKHOUSE_URL and retry.",
        });
      }
      const repo = new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      return repo.getHrZones(input.id);
    }),

  powerZones: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ id: z.guid() }))
    .query(async ({ ctx, input }): Promise<ActivityPowerZonesResult | null> => {
      const activityRepo = new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const activity = await activityRepo.findById(input.id);
      if (!activity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
      }
      if (!isCyclingActivity(activity.canonical_type)) return null;
      if (activity.avg_power == null && activity.max_power == null) return null;
      if (!ctx.sensorStore) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "ClickHouse activity analytics store is required for power analysis. Set CLICKHOUSE_URL and retry.",
        });
      }

      const powerRepo = new PowerRepository(ctx.userId, ctx.timezone, ctx.sensorStore);
      const { currentEftp } = await powerRepo.getEftpTrend(ChartRange.fromDays(90));
      if (currentEftp == null) return null;

      const zones = await activityRepo.getPowerZones(input.id, currentEftp);
      return { zones, ftp: currentEftp };
    }),

  strengthExercises: cachedProtectedQuery({ maxAge: CacheTTL.MEDIUM })
    .input(z.object({ id: z.guid() }))
    .query(async ({ ctx, input }): Promise<StrengthExerciseDetail[]> => {
      const activityRepo = new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
        ctx.sensorStore,
      );
      const activity = await activityRepo.findById(input.id);
      if (!activity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
      }
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const exercises = await repo.getExercisesForActivity(input.id);
      return exercises.map((exercise) => exercise.toDetail());
    }),

  recompute: protectedProcedure
    .input(z.object({ id: z.guid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        const memberActivityIds = await withAccountErasureUserWriteFence(
          ctx.db,
          ctx.userId,
          async (transaction) => {
            const repo = new ActivityRepository(
              transaction,
              ctx.userId,
              ctx.timezone,
              ctx.accessWindow,
            );
            const memberActivityIds = await repo.getActivityMemberIds(input.id);
            if (!memberActivityIds) {
              throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
            }
            return memberActivityIds;
          },
        );
        await scheduleActivityRecomputeAnalyticsRefresh(ctx.userId, memberActivityIds);
        await invalidateActivityListCaches(ctx.userId);
        return { success: true };
      } catch (error) {
        if (error instanceof TRPCError) {
          throw error;
        }
        if (isRelationMissingError(error)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
          });
        }
        throw error;
      }
    }),

  delete: protectedProcedure.input(z.object({ id: z.guid() })).mutation(async ({ ctx, input }) => {
    try {
      const memberActivityIds = await withAccountErasureUserWriteFence(
        ctx.db,
        ctx.userId,
        async (transaction) => {
          const repo = new ActivityRepository(
            transaction,
            ctx.userId,
            ctx.timezone,
            ctx.accessWindow,
          );
          const { memberActivityIds } = await repo.bulkDelete([input.id]);
          return memberActivityIds;
        },
      );
      await invalidateActivityListCaches(ctx.userId);
      await scheduleActivityAnalyticsRefresh(ctx.userId, memberActivityIds);
      return { success: true };
    } catch (error) {
      if (isRelationMissingError(error)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
        });
      }
      throw error;
    }
  }),

  bulkDelete: protectedProcedure
    .input(z.object({ ids: z.array(z.guid()).min(1).max(MAX_BULK_DELETE_ACTIVITY_IDS) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const deletion = await withAccountErasureUserWriteFence(
          ctx.db,
          ctx.userId,
          async (transaction) => {
            const repo = new ActivityRepository(
              transaction,
              ctx.userId,
              ctx.timezone,
              ctx.accessWindow,
            );
            return repo.bulkDelete(input.ids);
          },
        );
        await invalidateActivityListCaches(ctx.userId);
        await scheduleActivityAnalyticsRefresh(ctx.userId, deletion.memberActivityIds);
        return { success: true, deletedCount: deletion.deletedCount };
      } catch (error) {
        if (isRelationMissingError(error)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
          });
        }
        throw error;
      }
    }),

  restoreProviderAbsent: protectedProcedure
    .input(z.object({ ids: z.array(z.guid()).min(1).max(MAX_BULK_DELETE_ACTIVITY_IDS) }))
    .mutation(async ({ ctx, input }) => {
      try {
        const restoredCount = await withAccountErasureUserWriteFence(
          ctx.db,
          ctx.userId,
          async (transaction) => {
            const repo = new ActivityRepository(
              transaction,
              ctx.userId,
              ctx.timezone,
              ctx.accessWindow,
            );
            const { restoredCount } = await repo.restoreProviderAbsent(input.ids);
            return restoredCount;
          },
        );
        await invalidateActivityListCaches(ctx.userId);
        await scheduleActivityRestoreAnalyticsRefresh(ctx.userId, input.ids);
        return { success: true, restoredCount };
      } catch (error) {
        if (isRelationMissingError(error)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Activity data is unavailable because the activity view is missing. Run migrations and retry.",
          });
        }
        throw error;
      }
    }),
});

/** Map a raw stream row to a StreamPoint. Exported for backward compatibility. */
export function mapStreamPoint(row: {
  recorded_at: string;
  heart_rate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
  lat: number | null;
  lng: number | null;
}): StreamPoint {
  return new StreamPointModel(row).toDetail();
}
