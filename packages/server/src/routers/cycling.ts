import { activityDataStateSchema } from "@dofek/format/activity-data-state";
import { formatDateYmdInTimeZone } from "@dofek/format/format";
import { ACTIVITY_MODALITIES } from "@dofek/training/activity-types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  cyclingDurabilityResultSchema,
  cyclingDurabilitySelectionSchema,
} from "../contracts/cycling-durability.ts";
import { trainingChartAvailabilitySchema } from "../contracts/training-chart-availability.ts";
import { selectedChartCustomRangeQuery, selectedChartRangeQuery } from "../lib/chart-range.ts";
import { selectedChartRangeDaysSchema } from "../lib/date-window.ts";
import { CyclingAnalyticsRepository } from "../repositories/cycling-analytics-repository.ts";
import {
  CyclingDecouplingRepository,
  cyclingDecouplingOutputSchema,
} from "../repositories/cycling-decoupling-repository.ts";
import { CyclingDurabilityRepository } from "../repositories/cycling-durability-repository.ts";
import { CacheTTL, router } from "../trpc.ts";

const powerModelSchema = z.object({
  cp: z.number(),
  wPrime: z.number(),
  r2: z.number(),
});
const powerPointSchema = z.object({
  durationSeconds: z.number(),
  label: z.string(),
  bestPower: z.number(),
  activityDate: z.string(),
  sourceActivityId: z.string().nullable(),
  sourceActivityName: z.string().nullable(),
});
const powerCurveSchema = z.object({
  points: z.array(powerPointSchema),
  model: powerModelSchema.nullable(),
});
const powerSummaryPeriodSchema = z.object({
  efforts: z.array(
    z.object({
      durationSeconds: z.number(),
      watts: z.number(),
      wattsPerKg: z.number().nullable(),
    }),
  ),
  maximalAerobicPower: z.number().nullable(),
  vo2Max: z.number().nullable(),
  timeToExhaustionSeconds: z.number().nullable(),
});
const sourceWorkoutSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  date: z.string(),
});
const estimateEvidenceSchema = z.object({
  method: z.string(),
  confidence: z.enum(["high", "moderate", "limited", "not_available"]),
  confidenceLabel: z.string(),
  confidenceDetail: z.string().nullable(),
  sourceWorkouts: z.array(sourceWorkoutSchema),
  pacingGuidance: z.string(),
});
const estimateEvidenceByPeriodSchema = z.object({
  threshold: estimateEvidenceSchema,
  vo2Max: estimateEvidenceSchema,
});
const pmcSchema = z.object({
  unavailableReason: z.string().nullable(),
  data: z.array(
    z.object({
      date: z.string(),
      load: z.number(),
      ctl: z.number(),
      atl: z.number(),
      tsb: z.number(),
    }),
  ),
  model: z.object({
    ftp: z.number().nullable(),
  }),
});
const performanceOutputSchema = z.object({
  powerCurve: z.object({ recent: powerCurveSchema, season: powerCurveSchema }),
  powerSummary: z.object({
    weightKg: z.number().nullable(),
    recent: powerSummaryPeriodSchema,
    season: powerSummaryPeriodSchema,
  }),
  pmc: pmcSchema,
  availability: z.object({
    powerCurve: trainingChartAvailabilitySchema,
    pmc: trainingChartAvailabilitySchema,
  }),
  estimateEvidence: z.object({
    recent: estimateEvidenceByPeriodSchema,
    season: estimateEvidenceByPeriodSchema,
  }),
});

const activityItemSchema = z.object({
  id: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  canonical_type: z.string(),
  primary_canonical_type: z.string().nullable(),
  name: z.string().nullable(),
  provider_id: z.string(),
  source_providers: z.array(z.string()),
  distance_meters: z.number().nullable(),
  distance_state: activityDataStateSchema,
  elevation_gain_m: z.number().nullable(),
  elevation_state: activityDataStateSchema,
});
const activitiesOutputSchema = z.object({
  activities: z.object({ items: z.array(activityItemSchema), totalCount: z.number() }),
  variability: z.object({
    rows: z.array(
      z.object({
        activityId: z.string(),
        date: z.string(),
        activityName: z.string(),
        normalizedPower: z.number(),
        averagePower: z.number(),
        variabilityIndex: z.number(),
        intensityFactor: z.number(),
      }),
    ),
    totalCount: z.number(),
    emptyReason: z
      .enum(["no_cycling_activities", "no_configured_ftp", "no_normalized_power"])
      .nullable(),
  }),
  verticalAscent: z.array(
    z.object({
      activityId: z.string(),
      date: z.string(),
      activityName: z.string(),
      activityType: z.string(),
      modality: z.enum(ACTIVITY_MODALITIES).nullable(),
      verticalAscentRate: z.number(),
      elevationGainMeters: z.number(),
      elapsedMinutes: z.number(),
    }),
  ),
  aerobicEfficiency: z.object({
    maxHr: z.number().nullable(),
    activities: z.array(
      z.object({
        date: z.string(),
        activityType: z.string(),
        name: z.string(),
        avgPowerZ2: z.number(),
        avgHrZ2: z.number(),
        efficiencyFactor: z.number(),
        z2Samples: z.number(),
      }),
    ),
  }),
  availability: z.object({
    verticalAscent: trainingChartAvailabilitySchema,
    aerobicEfficiency: trainingChartAvailabilitySchema,
  }),
});

function requireSensorStore(
  sensorStore: ConstructorParameters<typeof CyclingAnalyticsRepository>[3] | undefined,
) {
  if (!sensorStore) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "ClickHouse activity analytics store is required for cycling analytics. Set CLICKHOUSE_URL and retry.",
    });
  }
  return sensorStore;
}

function requireRepository(ctx: {
  db: ConstructorParameters<typeof CyclingAnalyticsRepository>[0];
  userId: string;
  timezone: string;
  sensorStore: ConstructorParameters<typeof CyclingAnalyticsRepository>[3] | undefined;
  accessWindow: ConstructorParameters<typeof CyclingAnalyticsRepository>[4];
}) {
  return new CyclingAnalyticsRepository(
    ctx.db,
    ctx.userId,
    ctx.timezone,
    requireSensorStore(ctx.sensorStore),
    ctx.accessWindow,
  );
}

export const cyclingRouter = router({
  decoupling: selectedChartRangeQuery(
    "cycling.decoupling",
    CacheTTL.LONG,
    ({ ctx, range }) =>
      new CyclingDecouplingRepository(
        requireSensorStore(ctx.sensorStore),
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      ).getTrend(range),
    { expiresAt: "localDayBoundary", outputSchema: cyclingDecouplingOutputSchema },
  ),
  durability: selectedChartCustomRangeQuery(
    "cycling.durability",
    CacheTTL.LONG,
    cyclingDurabilitySelectionSchema.extend({
      days: selectedChartRangeDaysSchema("cycling.durability"),
    }),
    ({ ctx, range, input }) =>
      new CyclingDurabilityRepository(
        requireSensorStore(ctx.sensorStore),
        ctx.userId,
        ctx.timezone,
        ctx.accessWindow,
      ).getComparison(
        range,
        {
          durationSeconds: input.durationSeconds,
          minimumWorkKilojoulesPerKg: input.minimumWorkKilojoulesPerKg,
        },
        formatDateYmdInTimeZone(new Date(), ctx.timezone),
      ),
    cyclingDurabilityResultSchema,
    {
      keyVersion: "cycling-durability-v1",
      expiresAt: "localDayBoundary",
      scopeByAccessWindow: true,
    },
  ),
  performance: selectedChartRangeQuery(
    "cycling.performance",
    CacheTTL.LONG,
    async ({ ctx, range }) =>
      performanceOutputSchema.parse(await requireRepository(ctx).getPerformance(range)),
    { expiresAt: "localDayBoundary", keyVersion: "manual-ftp-power-stress-v6" },
  ),
  activities: selectedChartCustomRangeQuery(
    "cycling.activities",
    CacheTTL.LONG,
    z.object({
      days: selectedChartRangeDaysSchema("cycling.activities"),
      activityLimit: z.number().int().min(1).max(100).default(20),
      activityOffset: z.number().int().min(0).default(0),
      variabilityLimit: z.number().int().min(1).max(100).default(20),
      variabilityOffset: z.number().int().min(0).default(0),
    }),
    async ({ ctx, input, range }) =>
      activitiesOutputSchema.parse(await requireRepository(ctx).getActivities(range, input)),
    activitiesOutputSchema,
    { keyVersion: "cycling-activity-manual-ftp-ascent-v5" },
  ),
});
