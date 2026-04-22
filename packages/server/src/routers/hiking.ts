import { z } from "zod";
import type { RouteInstance } from "../repositories/hiking-repository.ts";
import { HikingRepository } from "../repositories/hiking-repository.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

// ---------------------------------------------------------------------------
// API-facing types (consumed by web/mobile via dofek-server/types)
// ---------------------------------------------------------------------------

export interface GradeAdjustedPaceRow {
  activityId: string;
  date: string;
  activityName: string;
  activityType: string;
  distanceKm: number;
  durationMinutes: number;
  averagePaceMinPerKm: number;
  gradeAdjustedPaceMinPerKm: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
}

export interface ElevationProfileRow {
  week: string;
  elevationGainMeters: number;
  activityCount: number;
  totalDistanceKm: number;
}

export interface WalkingBiomechanicsRow {
  date: string;
  walkingSpeedKmh: number | null;
  stepLengthCm: number | null;
  doubleSupportPct: number | null;
  asymmetryPct: number | null;
  steadiness: number | null;
}

export type { RouteInstance as ActivityComparisonInstance };

export interface ActivityComparisonRow {
  activityName: string;
  instances: RouteInstance[];
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const hikingRouter = router({
  gradeAdjustedPace: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const repo = new HikingRepository(ctx.db, ctx.userId, ctx.timezone);
      const activities = await repo.getGradeAdjustedPaces(input.days);
      return activities.map((activity) => activity.toDetail());
    }),

  elevationProfile: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      const repo = new HikingRepository(ctx.db, ctx.userId, ctx.timezone);
      const weeks = await repo.getElevationProfile(input.days);
      return weeks.map((week) => week.toDetail());
    }),

  walkingBiomechanics: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(90) }))
    .query(async ({ ctx, input }) => {
      const repo = new HikingRepository(ctx.db, ctx.userId, ctx.timezone);
      const snapshots = await repo.getWalkingBiomechanics(input.days);
      return snapshots.map((snapshot) => snapshot.toDetail());
    }),

  activityComparison: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({ days: z.number().default(365) }))
    .query(async ({ ctx, input }) => {
      const repo = new HikingRepository(ctx.db, ctx.userId, ctx.timezone);
      const routes = await repo.getRepeatedRoutes(input.days);
      return routes.map((route) => route.toDetail());
    }),
});
