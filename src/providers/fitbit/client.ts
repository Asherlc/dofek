import { z } from "zod";
import { ProviderHttpClient } from "../http-client.ts";

// ============================================================
// Fitbit API Zod schemas
// ============================================================

const fitbitHeartRateZoneSchema = z.object({
  name: z.string(),
  min: z.number(),
  max: z.number(),
  minutes: z.number(),
});

export const fitbitActivitySchema = z.object({
  logId: z.number(),
  activityName: z.string(),
  activityTypeId: z.number(),
  startTime: z.string(),
  activeDuration: z.number(),
  calories: z.number(),
  distance: z.number().optional(),
  distanceUnit: z.string(),
  steps: z.number().optional(),
  averageHeartRate: z.number().optional(),
  heartRateZones: z.array(fitbitHeartRateZoneSchema).optional(),
  logType: z.string(),
  startDate: z.string(),
  tcxLink: z.string().optional(),
});

export type FitbitActivity = z.infer<typeof fitbitActivitySchema>;

const fitbitPaginationSchema = z.object({
  next: z.string(),
  previous: z.string(),
  limit: z.number(),
  offset: z.number(),
  sort: z.string(),
});

const fitbitActivityListResponseSchema = z.object({
  activities: z.array(fitbitActivitySchema),
  pagination: fitbitPaginationSchema,
});

export type FitbitActivityListResponse = z.infer<typeof fitbitActivityListResponseSchema>;

const fitbitSleepStageSummarySchema = z.object({
  count: z.number(),
  minutes: z.number(),
  thirtyDayAvgMinutes: z.number(),
});

export const fitbitSleepLogSchema = z.object({
  logId: z.number(),
  dateOfSleep: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  duration: z.number(),
  efficiency: z.number(),
  isMainSleep: z.boolean(),
  type: z.enum(["stages", "classic"]),
  levels: z.object({
    summary: z.object({
      deep: fitbitSleepStageSummarySchema.optional(),
      light: fitbitSleepStageSummarySchema.optional(),
      rem: fitbitSleepStageSummarySchema.optional(),
      wake: fitbitSleepStageSummarySchema.optional(),
    }),
  }),
});

export type FitbitSleepLog = z.infer<typeof fitbitSleepLogSchema>;

const fitbitSleepListResponseSchema = z.object({
  sleep: z.array(fitbitSleepLogSchema),
  pagination: fitbitPaginationSchema,
});

export type FitbitSleepListResponse = z.infer<typeof fitbitSleepListResponseSchema>;

export const fitbitDailySummarySchema = z.object({
  summary: z.object({
    steps: z.number(),
    caloriesOut: z.number(),
    activeScore: z.number(),
    activityCalories: z.number(),
    restingHeartRate: z.number().optional(),
    distances: z.array(z.object({ activity: z.string(), distance: z.number() })),
    fairlyActiveMinutes: z.number(),
    veryActiveMinutes: z.number(),
    lightlyActiveMinutes: z.number(),
    sedentaryMinutes: z.number(),
    floors: z.number().optional(),
  }),
});

export type FitbitDailySummary = z.infer<typeof fitbitDailySummarySchema>;

export const fitbitWeightLogSchema = z.object({
  logId: z.number(),
  weight: z.number(),
  bmi: z.number(),
  fat: z.number().optional(),
  date: z.string(),
  time: z.string(),
});

export type FitbitWeightLog = z.infer<typeof fitbitWeightLogSchema>;

const fitbitWeightListResponseSchema = z.object({
  weight: z.array(fitbitWeightLogSchema),
});

type FitbitWeightListResponse = z.infer<typeof fitbitWeightListResponseSchema>;

// ============================================================
// Fitbit API client
// ============================================================

export const FITBIT_API_BASE = "https://api.fitbit.com";

export class FitbitClient extends ProviderHttpClient {
  constructor(accessToken: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    super(accessToken, FITBIT_API_BASE, fetchFn);
  }

  async getActivities(afterDate: string, offset = 0): Promise<FitbitActivityListResponse> {
    return this.get(
      `/1/user/-/activities/list.json?afterDate=${afterDate}&sort=asc&limit=20&offset=${offset}`,
      fitbitActivityListResponseSchema,
    );
  }

  async getSleepLogs(afterDate: string, offset = 0): Promise<FitbitSleepListResponse> {
    return this.get(
      `/1.2/user/-/sleep/list.json?afterDate=${afterDate}&sort=asc&limit=20&offset=${offset}`,
      fitbitSleepListResponseSchema,
    );
  }

  async getDailySummary(date: string): Promise<FitbitDailySummary> {
    return this.get(`/1/user/-/activities/date/${date}.json`, fitbitDailySummarySchema);
  }

  async getWeightLogs(startDate: string): Promise<FitbitWeightListResponse> {
    return this.get(
      `/1/user/-/body/log/weight/date/${startDate}/30d.json`,
      fitbitWeightListResponseSchema,
    );
  }

  async downloadTcx(tcxLink: string): Promise<string> {
    const url = tcxLink.startsWith("http") ? tcxLink : `${FITBIT_API_BASE}${tcxLink}`;
    const response = await this.fetchFn(url, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Failed to download TCX (${response.status})`);
    }
    return response.text();
  }
}
