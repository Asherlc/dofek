import { TRPCError } from "@trpc/server";
import { selectedChartRangeQuery } from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import type { RouteInstance } from "../repositories/hiking-repository.ts";
import { HikingRepository } from "../repositories/hiking-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

function requireSensorStore(
  sensorStore: ActivitySensorStore | undefined,
  feature: string,
): ActivitySensorStore {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires the ClickHouse activity analytics store. Set CLICKHOUSE_URL and retry.`,
    });
  }
  return sensorStore;
}

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
  gradeAdjustedPace: selectedChartRangeQuery(
    "hiking.gradeAdjustedPace",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "hiking.gradeAdjustedPace");
      const repo = new HikingRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const activities = await repo.getGradeAdjustedPaces(range.days);
      return activities.map((activity) => activity.toDetail());
    },
  ),

  elevationProfile: selectedChartRangeQuery(
    "hiking.elevationProfile",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "hiking.elevationProfile");
      const repo = new HikingRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const weeks = await repo.getElevationProfile(range.days);
      return weeks.map((week) => week.toDetail());
    },
  ),

  walkingBiomechanics: selectedChartRangeQuery(
    "hiking.walkingBiomechanics",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "hiking.walkingBiomechanics");
      const repo = new HikingRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const snapshots = await repo.getWalkingBiomechanics(range.days);
      return snapshots.map((snapshot) => snapshot.toDetail());
    },
  ),

  activityComparison: selectedChartRangeQuery(
    "hiking.activityComparison",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "hiking.activityComparison");
      const repo = new HikingRepository(ctx.db, ctx.userId, ctx.timezone, sensorStore);
      const routes = await repo.getRepeatedRoutes(range.days);
      return routes.map((route) => route.toDetail());
    },
  ),
});
