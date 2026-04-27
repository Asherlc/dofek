import { isCyclingActivity } from "@dofek/training/training";
import { TRPCError } from "@trpc/server";
import { isRelationMissingError } from "dofek/db/dedup";
import { getProvider } from "dofek/providers/registry";
import { z } from "zod";
import { endDateSchema } from "../lib/date-window.ts";
import { Activity, type ActivityDetail } from "../models/activity.ts";
import {
  ActivityRepository,
  StreamPoint as StreamPointModel,
} from "../repositories/activity-repository.ts";
import { PowerRepository } from "../repositories/power-repository.ts";
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

export interface ActivityPowerZonesResult {
  zones: import("@dofek/zones/zones").ActivityPowerZone[];
  ftp: number;
}

export const activityRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
        endDate: endDateSchema,
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
        activityTypes: z.array(z.string()).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      try {
        return await repo.list(input);
      } catch (error) {
        if (isRelationMissingError(error)) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message:
              "Activity data is temporarily unavailable — materialized views are being rebuilt. Try again in a few minutes.",
          });
        }
        throw error;
      }
    }),

  byId: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityDetail> => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
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
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const points = await repo.getStream(input.id, input.maxPoints);
      return points.map((point) => point.toDetail());
    }),

  hrZones: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityHrZones> => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      return repo.getHrZones(input.id);
    }),

  powerZones: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<ActivityPowerZonesResult | null> => {
      const activityRepo = new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      );
      const activity = await activityRepo.findById(input.id);
      if (!activity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
      }
      if (!isCyclingActivity(activity.activity_type)) return null;
      if (activity.avg_power == null && activity.max_power == null) return null;

      const powerRepo = new PowerRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
      const { currentEftp } = await powerRepo.getEftpTrend(90);
      if (currentEftp == null) return null;

      const zones = await activityRepo.getPowerZones(input.id, currentEftp);
      return { zones, ftp: currentEftp };
    }),

  strengthExercises: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<StrengthExerciseDetail[]> => {
      const activityRepo = new ActivityRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      );
      const activity = await activityRepo.findById(input.id);
      if (!activity) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
      }
      const repo = new StrengthRepository(ctx.db, ctx.userId, ctx.timezone);
      const exercises = await repo.getExercisesForActivity(input.id);
      return exercises.map((exercise) => exercise.toDetail());
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const repo = new ActivityRepository(ctx.db, ctx.userId, ctx.timezone, ctx.accessWindow);
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
