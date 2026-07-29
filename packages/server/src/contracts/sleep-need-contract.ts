import { z } from "zod";

export const MISSING_PREVIOUS_NIGHT_MESSAGE =
  "Sync last night's sleep data to see tonight's sleep need.";

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
  })
  .strict();

const missingPreviousNightSleepNeedV2Schema = z
  .object({
    availability: z.literal("missing_previous_night"),
    message: z.literal(MISSING_PREVIOUS_NIGHT_MESSAGE),
  })
  .strict();

export const sleepNeedV2Schema = z.discriminatedUnion("availability", [
  availableSleepNeedV2Schema,
  missingPreviousNightSleepNeedV2Schema,
]);

export type SleepNeedV2 = z.infer<typeof sleepNeedV2Schema>;

export interface SleepNeedComputation {
  baselineMinutes: number;
  strainDebtMinutes: number;
  accumulatedDebtMinutes: number;
  debtRecoveryMinutes: number;
  totalNeedMinutes: number;
  recentNights: SleepNight[];
  hasPreviousNight: boolean;
}

interface BuildSleepNeedComputationInput {
  baselineMinutes: number;
  strainDebtMinutes: number;
  accumulatedDebtMinutes: number;
  recentNights: SleepNight[];
  hasPreviousNight: boolean;
}

export function buildSleepNeedComputation({
  baselineMinutes,
  strainDebtMinutes,
  accumulatedDebtMinutes,
  recentNights,
  hasPreviousNight,
}: BuildSleepNeedComputationInput): SleepNeedComputation {
  const debtRecoveryMinutes = Math.round(accumulatedDebtMinutes * 0.25);
  return {
    baselineMinutes,
    strainDebtMinutes,
    accumulatedDebtMinutes,
    debtRecoveryMinutes,
    totalNeedMinutes: baselineMinutes + strainDebtMinutes + debtRecoveryMinutes,
    recentNights,
    hasPreviousNight,
  };
}

export function toSleepNeedV1(computation: SleepNeedComputation): SleepNeedResult {
  return sleepNeedV1Schema.parse({
    baselineMinutes: computation.baselineMinutes,
    strainDebtMinutes: computation.strainDebtMinutes,
    accumulatedDebtMinutes: computation.accumulatedDebtMinutes,
    totalNeedMinutes: computation.totalNeedMinutes,
    recentNights: computation.recentNights,
    canRecommend: computation.hasPreviousNight,
  });
}

export function toSleepNeedV2(computation: SleepNeedComputation): SleepNeedV2 {
  if (!computation.hasPreviousNight) {
    return {
      availability: "missing_previous_night",
      message: MISSING_PREVIOUS_NIGHT_MESSAGE,
    };
  }

  return sleepNeedV2Schema.parse({
    availability: "available",
    baselineMinutes: computation.baselineMinutes,
    strainDebtMinutes: computation.strainDebtMinutes,
    accumulatedDebtMinutes: computation.accumulatedDebtMinutes,
    debtRecoveryMinutes: computation.debtRecoveryMinutes,
    totalNeedMinutes: computation.totalNeedMinutes,
    recentNights: computation.recentNights,
  });
}
