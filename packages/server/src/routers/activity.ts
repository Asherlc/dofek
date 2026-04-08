import * as Sentry from "@sentry/node";
import { TRPCError } from "@trpc/server";
import { getProvider } from "dofek/providers/registry";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { logger } from "../logger.ts";
import { Activity, type ActivityDetail } from "../models/activity.ts";
import {
  ActivityRepository,
  StreamPoint as StreamPointModel,
} from "../repositories/activity-repository.ts";
import { StrengthRepository } from "../repositories/strength-repository.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";
import { ensureProvidersRegistered } from "./sync.ts";

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

export const activityRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
        endDate: endDateSchema,
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      const result = await repo.list(input);

      // Self-healing: if the materialized view returns no results but the base
      // table has data, the views are stale (e.g. after a crash recovery or
      // failed view refresh). Refresh them and retry the query.
      if (result.totalCount === 0) {
        const baseCount = await repo.baseTableCount();
        if (baseCount > 0) {
          logger.warn(
            `[activity] Stale views detected for user ${ctx.userId}: ` +
              `${baseCount} activities in base table but 0 in materialized view. Refreshing.`,
          );
          Sentry.captureMessage("Stale activity materialized views detected", {
            level: "warning",
            tags: { userId: ctx.userId },
            extra: { baseCount },
          });
          try {
            await repo.refreshActivityViews();
            return repo.list(input);
          } catch (refreshError) {
            logger.error(`[activity] Failed to refresh stale views: ${refreshError}`);
            Sentry.captureException(refreshError, {
              tags: { userId: ctx.userId, context: "staleViewRefresh" },
            });
          }
        }
      }

      return result;
    }),

  byId: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityDetail> => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      const row = await repo.findById(input.id);

      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
      }

      await ensureProvidersRegistered();
      return new Activity(row, getProvider).toDetail();
    }),

  stream: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        id: z.string().uuid(),
        maxPoints: z.number().int().min(10).max(10000).default(500),
      }),
    )
    .query(async ({ ctx, input }): Promise<StreamPoint[]> => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      const points = await repo.getStream(input.id, input.maxPoints);
      return points.map((point) => point.toDetail());
    }),

  hrZones: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityHrZones> => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      return repo.getHrZones(input.id);
    }),

  strengthExercises: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<StrengthExerciseDetail[]> => {
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const exercises = await repo.getExercisesForActivity(input.id);
      return exercises.map((exercise) => exercise.toDetail());
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone);
      await repo.delete(input.id);
      return { success: true };
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
