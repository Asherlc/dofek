import {
  sportVolumeMetricSchema,
  sportVolumeMetrics,
  sportVolumeResultSchema,
} from "@dofek/training/sport-volume";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  selectedChartCustomRangeQuery,
  selectedChartRangeQuery,
  selectedChartRangeSchema,
} from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { SportVolumeRepository } from "../repositories/sport-volume-repository.ts";
import {
  type TrainingHrZonesResult,
  TrainingRepository,
} from "../repositories/training-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

const trainingHrZonesOutputSchema = z.object({
  maxHr: z.number().nullable(),
  weeks: z.array(
    z.object({
      max_hr: z.number().nullable(),
      week: z.string(),
      zone0: z.number(),
      zone1: z.number(),
      zone2: z.number(),
      zone3: z.number(),
      zone4: z.number(),
      zone5: z.number(),
    }),
  ),
  intensityDistribution: z.object({
    model: z.literal("karvonen-five-zone"),
    activityScope: z.literal("endurance"),
    totalSeconds: z.number(),
    zones: z.array(
      z.object({
        zone: z.number(),
        label: z.string(),
        seconds: z.number(),
        percent: z.number(),
      }),
    ),
    explanation: z.string(),
  }),
}) satisfies z.ZodType<TrainingHrZonesResult>;

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

export const trainingRouter = router({
  sportVolume: selectedChartCustomRangeQuery(
    "training.sportVolume",
    CacheTTL.LONG,
    z
      .object({
        days: selectedChartRangeSchema("training.sportVolume"),
        sport: z.string().min(1).max(100).optional(),
        metric: sportVolumeMetricSchema.default("time"),
      })
      .refine(
        (input) =>
          input.sport === undefined
            ? input.metric === "time"
            : sportVolumeMetrics(input.sport).some((metric) => metric.key === input.metric),
        { message: "Choose a volume metric supported by this sport.", path: ["metric"] },
      ),
    async ({ ctx, input }) =>
      new SportVolumeRepository(
        requireSensorStore(ctx.sensorStore, "Sport volume"),
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      ).getVolume(input),
    sportVolumeResultSchema,
  ),
  weeklyVolume: selectedChartRangeQuery(
    "training.weeklyVolume",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "training");
      const repo = new TrainingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getWeeklyVolume(range.days);
    },
  ),

  hrZones: selectedChartRangeQuery(
    "training.hrZones",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "training");
      const repo = new TrainingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getHrZones(range.days);
    },
    { outputSchema: trainingHrZonesOutputSchema },
  ),

  activityStats: selectedChartRangeQuery(
    "training.activityStats",
    CacheTTL.LONG,
    async ({ ctx, range }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "training");
      const repo = new TrainingRepository(
        ctx.db,
        ctx.userId,
        ctx.timezone,
        sensorStore,
        ctx.accessWindow,
      );
      return repo.getActivityStats(range.days);
    },
    { keyVersion: "training-activity-primary-title-v2" },
  ),
});
