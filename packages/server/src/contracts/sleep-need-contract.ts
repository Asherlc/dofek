import { z } from "zod";

export const MISSING_PREVIOUS_NIGHT_MESSAGE =
  "Sync last night's sleep data to see tonight's sleep need.";
export const INSUFFICIENT_BASELINE_HISTORY_MESSAGE =
  "Sync at least 7 qualifying nights to estimate sleep need.";
export const MISSING_PREVIOUS_DAY_LOAD_MESSAGE =
  "Sync yesterday's activity data to include training load in sleep need.";
export const INSUFFICIENT_BASELINE_HISTORY_NEXT_ACTION = "Sync more sleep and recovery data.";
export const MISSING_PREVIOUS_DAY_LOAD_NEXT_ACTION = "Sync activity data for the previous day.";

export const sleepNightSchema = z
  .object({
    date: z.string(),
    actualMinutes: z.number().nullable(),
    neededMinutes: z.number(),
    debtMinutes: z.number().nullable(),
    providerId: z.string().nullable(),
    sourceName: z.string().nullable(),
    sourceProviders: z.array(z.string()),
  })
  .strict();

export type SleepNight = z.infer<typeof sleepNightSchema>;

const sleepNeedEstimateMetadataSchema = z
  .object({
    basis: z.enum(["personalized_high_hrv_average", "generic_eight_hour_default"]),
    baselineQualifyingNightCount: z.number().int().nonnegative(),
    debtObservedNightCount: z.number().int().nonnegative(),
    methodVersion: z.literal("sleep-need-heuristic-v1"),
    uncertainty: z.literal("not_established"),
    valueQualifier: z.literal("About"),
    summaryLabel: z.literal("Heuristic estimate"),
    componentLabels: z
      .object({
        baseline: z.literal("Baseline estimate"),
        strainDebt: z.literal("Previous-day load adjustment"),
        debtRecovery: z.literal("Debt recovery"),
      })
      .strict(),
    basisLabel: z.string(),
    coverageLabel: z.string(),
    methodLabel: z.literal("Method: sleep-need-heuristic-v1"),
    uncertaintyLabel: z.literal("Uncertainty: not established"),
    limitationLabel: z.literal(
      "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established.",
    ),
  })
  .strict();

const sleepNeedRecommendationSchema = z
  .object({
    baselineMinutes: z.number(),
    strainDebtMinutes: z.number(),
    accumulatedDebtMinutes: z.number(),
    totalNeedMinutes: z.number(),
    recentNights: z.array(sleepNightSchema),
  })
  .strict();

export const sleepNeedV1Schema = sleepNeedRecommendationSchema
  .extend({
    canRecommend: z.boolean(),
  })
  .strict();

export type SleepNeedResult = z.infer<typeof sleepNeedV1Schema>;

const availableSleepNeedV2Schema = sleepNeedRecommendationSchema
  .extend({
    availability: z.literal("available"),
    debtRecoveryMinutes: z.number(),
    estimateMetadata: sleepNeedEstimateMetadataSchema,
  })
  .strict();

const missingPreviousNightSleepNeedV2Schema = z
  .object({
    availability: z.literal("missing_previous_night"),
    message: z.literal(MISSING_PREVIOUS_NIGHT_MESSAGE),
  })
  .strict();

const insufficientBaselineSleepNeedV2Schema = z
  .object({
    availability: z.literal("insufficient_data"),
    reason: z.literal("insufficient_baseline_history"),
    message: z.literal(INSUFFICIENT_BASELINE_HISTORY_MESSAGE),
    nextAction: z.literal(INSUFFICIENT_BASELINE_HISTORY_NEXT_ACTION),
  })
  .strict();

const missingPreviousDayLoadSleepNeedV2Schema = z
  .object({
    availability: z.literal("insufficient_data"),
    reason: z.literal("missing_previous_day_load"),
    message: z.literal(MISSING_PREVIOUS_DAY_LOAD_MESSAGE),
    nextAction: z.literal(MISSING_PREVIOUS_DAY_LOAD_NEXT_ACTION),
  })
  .strict();

export const sleepNeedV2Schema = z.union([
  availableSleepNeedV2Schema,
  missingPreviousNightSleepNeedV2Schema,
  insufficientBaselineSleepNeedV2Schema,
  missingPreviousDayLoadSleepNeedV2Schema,
]);

export type SleepNeedV2 = z.infer<typeof sleepNeedV2Schema>;

export interface SleepNeedComputation {
  baselineMinutes: number;
  strainDebtMinutes: number;
  accumulatedDebtMinutes: number;
  debtRecoveryMinutes: number;
  totalNeedMinutes: number;
  baselineQualifyingNightCount: number;
  debtObservedNightCount: number;
  recentNights: SleepNight[];
  hasPreviousNight: boolean;
  hasYesterdayLoad: boolean;
}

interface BuildSleepNeedComputationInput {
  baselineMinutes: number;
  strainDebtMinutes: number;
  accumulatedDebtMinutes: number;
  baselineQualifyingNightCount: number;
  debtObservedNightCount: number;
  recentNights: SleepNight[];
  hasPreviousNight: boolean;
  hasYesterdayLoad: boolean;
}

export function buildSleepNeedComputation({
  baselineMinutes,
  strainDebtMinutes,
  accumulatedDebtMinutes,
  baselineQualifyingNightCount,
  debtObservedNightCount,
  recentNights,
  hasPreviousNight,
  hasYesterdayLoad,
}: BuildSleepNeedComputationInput): SleepNeedComputation {
  const debtRecoveryMinutes = Math.round(accumulatedDebtMinutes * 0.25);
  return {
    baselineMinutes,
    strainDebtMinutes,
    accumulatedDebtMinutes,
    debtRecoveryMinutes,
    totalNeedMinutes: baselineMinutes + strainDebtMinutes + debtRecoveryMinutes,
    baselineQualifyingNightCount,
    debtObservedNightCount,
    recentNights,
    hasPreviousNight,
    hasYesterdayLoad,
  };
}

export function toSleepNeedV1(computation: SleepNeedComputation): SleepNeedResult {
  return sleepNeedV1Schema.parse({
    baselineMinutes: computation.baselineMinutes,
    strainDebtMinutes: computation.strainDebtMinutes,
    accumulatedDebtMinutes: computation.accumulatedDebtMinutes,
    totalNeedMinutes: computation.totalNeedMinutes,
    recentNights: computation.recentNights,
    canRecommend:
      computation.hasPreviousNight &&
      computation.hasYesterdayLoad &&
      computation.baselineQualifyingNightCount >= 7,
  });
}

export function toSleepNeedV2(computation: SleepNeedComputation): SleepNeedV2 {
  if (!computation.hasPreviousNight) {
    return {
      availability: "missing_previous_night",
      message: MISSING_PREVIOUS_NIGHT_MESSAGE,
    };
  }

  if (!computation.hasYesterdayLoad) {
    return {
      availability: "insufficient_data",
      reason: "missing_previous_day_load",
      message: MISSING_PREVIOUS_DAY_LOAD_MESSAGE,
      nextAction: MISSING_PREVIOUS_DAY_LOAD_NEXT_ACTION,
    };
  }

  if (computation.baselineQualifyingNightCount < 7) {
    return {
      availability: "insufficient_data",
      reason: "insufficient_baseline_history",
      message: INSUFFICIENT_BASELINE_HISTORY_MESSAGE,
      nextAction: INSUFFICIENT_BASELINE_HISTORY_NEXT_ACTION,
    };
  }

  const basis = "personalized_high_hrv_average" as const;
  const qualifyingNightNoun = computation.baselineQualifyingNightCount === 1 ? "night" : "nights";
  const observedNightNoun = computation.debtObservedNightCount === 1 ? "night" : "nights";
  const basisLabel = `Baseline uses the average of ${computation.baselineQualifyingNightCount} qualifying ${qualifyingNightNoun} followed by at-or-above-median heart rate variability.`;

  return sleepNeedV2Schema.parse({
    availability: "available",
    baselineMinutes: computation.baselineMinutes,
    strainDebtMinutes: computation.strainDebtMinutes,
    accumulatedDebtMinutes: computation.accumulatedDebtMinutes,
    debtRecoveryMinutes: computation.debtRecoveryMinutes,
    totalNeedMinutes: computation.totalNeedMinutes,
    estimateMetadata: {
      basis,
      baselineQualifyingNightCount: computation.baselineQualifyingNightCount,
      debtObservedNightCount: computation.debtObservedNightCount,
      methodVersion: "sleep-need-heuristic-v1",
      uncertainty: "not_established",
      valueQualifier: "About",
      summaryLabel: "Heuristic estimate",
      componentLabels: {
        baseline: "Baseline estimate",
        strainDebt: "Previous-day load adjustment",
        debtRecovery: "Debt recovery",
      },
      basisLabel,
      coverageLabel: `Sleep-debt input uses ${computation.debtObservedNightCount} observed ${observedNightNoun} from the model's recent-night window.`,
      methodLabel: "Method: sleep-need-heuristic-v1",
      uncertaintyLabel: "Uncertainty: not established",
      limitationLabel:
        "This is a descriptive heuristic estimate, not a sleep recommendation. Its uncertainty has not been established.",
    },
    recentNights: computation.recentNights,
  });
}
