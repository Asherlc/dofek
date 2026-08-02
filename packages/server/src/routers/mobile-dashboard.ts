import { TRPCError } from "@trpc/server";
import { getEffectiveParams } from "dofek/personalization/params";
import { loadPersonalizedParams } from "dofek/personalization/storage";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { sleepNeedV1Schema, sleepNeedV2Schema } from "../contracts/sleep-need-contract.ts";
import { dateWindowInput, endDateSchema } from "../lib/date-window.ts";
import { logger } from "../logger.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import type { AnomalyCheckResult } from "../repositories/anomaly-detection-repository.ts";
import { ProcessingRepository } from "../repositories/processing-repository.ts";
import { baselineProcessingStatus } from "../services/baseline-progress.ts";
import { loadDashboardOverview } from "../services/dashboard-overview.ts";
import { HEALTH_STATUS_CACHE_KEY_VERSION } from "../services/health-status.ts";
import {
  loadMobileRecoveryTab,
  mobileRecoveryTabOutputSchema,
} from "../services/mobile-recovery-tab.ts";
import {
  loadMobileTrainingTab,
  mobileTrainingTabOutputSchema,
} from "../services/mobile-training-tab.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

const MOBILE_TRAINING_CACHE_KEY_VERSION = "training-activity-states-v2";

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

function requireAccessWindow(
  accessWindow: AccessWindow | undefined,
  feature: string,
): AccessWindow {
  if (!accessWindow) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `${feature} requires resolved entitlement access window.`,
    });
  }
  return accessWindow;
}

const anomalyCheckOutputSchema = z.object({
  anomalies: z.array(
    z.object({
      date: z.string(),
      metric: z.string(),
      value: z.number(),
      baselineMean: z.number(),
      baselineStddev: z.number(),
      zScore: z.number(),
      severity: z.enum(["warning", "alert"]),
    }),
  ),
  checkedMetrics: z.array(z.string()),
}) satisfies z.ZodType<AnomalyCheckResult>;

const mobileDashboardSharedOutputSchema = z.object({
  readiness: z
    .object({
      score: z.number(),
      date: z.string(),
      components: z.object({
        hrvScore: z.number(),
        restingHrScore: z.number(),
        sleepScore: z.number(),
        respiratoryRateScore: z.number(),
      }),
      weights: z.object({
        hrv: z.number(),
        restingHr: z.number(),
        sleep: z.number(),
        respiratoryRate: z.number(),
      }),
    })
    .nullable(),
  sleep: z
    .object({
      lastNight: z
        .object({
          date: z.string(),
          durationMinutes: z.number(),
          deepPct: z.number().nullable(),
          remPct: z.number().nullable(),
          lightPct: z.number().nullable(),
          awakePct: z.number().nullable(),
          stagingAvailable: z.boolean(),
        })
        .nullable(),
      sleepDebt: z.number(),
    })
    .nullable(),
  strain: z.object({
    dailyStrain: z.number(),
    acuteLoad: z.number(),
    chronicLoad: z.number(),
    workloadRatio: z.number().nullable(),
    date: z.string().nullable(),
  }),
  anomalies: anomalyCheckOutputSchema.nullable(),
  latestDate: z.string().nullable(),
});

const mobileDashboardOutputSchema = mobileDashboardSharedOutputSchema.extend({
  sleepNeed: sleepNeedV1Schema.nullable(),
});

const mobileDashboardV2OutputSchema = mobileDashboardSharedOutputSchema.extend({
  sleepNeed: sleepNeedV2Schema,
});

export type MobileDashboardResult = z.infer<typeof mobileDashboardOutputSchema>;
export type MobileDashboardV2Result = z.infer<typeof mobileDashboardV2OutputSchema>;

export const mobileDashboardRouter = router({
  dashboard: cachedProtectedQuery({ maxAge: CacheTTL.SHORT })
    .input(z.object({ endDate: endDateSchema }))
    .output(mobileDashboardOutputSchema)
    .query(async ({ ctx, input }): Promise<MobileDashboardResult> => {
      const { endDate } = input;
      const sensorStore = requireSensorStore(ctx.sensorStore, "mobileDashboard.dashboard");
      const accessWindow = ctx.accessWindow ?? { kind: "full" as const };
      const dashboardStart = performance.now();
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const result = await loadDashboardOverview({
        accessWindow,
        endDate,
        readinessWeights: getEffectiveParams(storedParams).readinessWeights,
        sensorStore,
        userId: ctx.userId,
      });
      logger.info(
        `[mobile-dashboard] dashboard timings userId=${ctx.userId} endDate=${endDate} total=${Math.round(performance.now() - dashboardStart)}ms`,
      );
      return result;
    }),

  dashboardV2: cachedProtectedQuery({
    maxAge: CacheTTL.SHORT,
    keyVersion: "sleep-need-metadata-v2",
  })
    .input(z.object({ endDate: endDateSchema }))
    .output(mobileDashboardV2OutputSchema)
    .query(async ({ ctx, input }): Promise<MobileDashboardV2Result> => {
      const { endDate } = input;
      const sensorStore = requireSensorStore(ctx.sensorStore, "mobileDashboard.dashboardV2");
      const accessWindow = ctx.accessWindow ?? { kind: "full" as const };
      const dashboardStart = performance.now();
      const storedParams = await loadPersonalizedParams(ctx.db, ctx.userId);
      const result = await loadDashboardOverview({
        accessWindow,
        endDate,
        readinessWeights: getEffectiveParams(storedParams).readinessWeights,
        sensorStore,
        userId: ctx.userId,
      });
      logger.info(
        `[mobile-dashboard] dashboardV2 timings userId=${ctx.userId} endDate=${endDate} total=${Math.round(performance.now() - dashboardStart)}ms`,
      );
      return {
        ...result,
        sleepNeed: result.sleepNeedV2,
      };
    }),

  recovery: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    keyVersion: HEALTH_STATUS_CACHE_KEY_VERSION,
  })
    .input(dateWindowInput)
    .output(mobileRecoveryTabOutputSchema)
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "mobileDashboard.recovery");
      const tabStart = performance.now();
      const processingSnapshot = await new ProcessingRepository(ctx.db, ctx.userId).status({
        datasets: ["recovery"],
      });
      const result = await loadMobileRecoveryTab(
        {
          db: ctx.db,
          userId: ctx.userId,
          timezone: ctx.timezone ?? "UTC",
          accessWindow: requireAccessWindow(ctx.accessWindow, "mobileDashboard.recovery"),
          sensorStore,
          processingStatus: baselineProcessingStatus(processingSnapshot, "recovery"),
        },
        input.days,
        input.endDate,
      );
      logger.info(
        `[mobile-dashboard] recovery timings userId=${ctx.userId} endDate=${input.endDate} days=${input.days} total=${Math.round(performance.now() - tabStart)}ms`,
      );
      return result;
    }),

  training: cachedProtectedQuery({
    maxAge: CacheTTL.MEDIUM,
    keyVersion: MOBILE_TRAINING_CACHE_KEY_VERSION,
  })
    .input(dateWindowInput)
    .output(mobileTrainingTabOutputSchema)
    .query(async ({ ctx, input }) => {
      const sensorStore = requireSensorStore(ctx.sensorStore, "mobileDashboard.training");
      const tabStart = performance.now();
      const result = await loadMobileTrainingTab(
        {
          db: ctx.db,
          userId: ctx.userId,
          timezone: ctx.timezone ?? "UTC",
          accessWindow: requireAccessWindow(ctx.accessWindow, "mobileDashboard.training"),
          sensorStore,
        },
        input.days,
        input.endDate,
      );
      logger.info(
        `[mobile-dashboard] training timings userId=${ctx.userId} endDate=${input.endDate} days=${input.days} total=${Math.round(performance.now() - tabStart)}ms`,
      );
      return result;
    }),
});
