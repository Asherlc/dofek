import { z } from "zod";

// ── Schemas for well-typed tRPC endpoints (used for documentation/reuse) ──

export interface ReadinessComponents {
  // Field names match the server's recovery router output
  hrvScore: number;
  restingHrScore: number;
  sleepScore: number;
  loadBalanceScore: number;
}

export interface ReadinessRow {
  date: string;
  readinessScore: number;
  components: ReadinessComponents;
}

export interface SleepNightlyRow {
  date: string;
  durationMinutes: number;
  deepPct: number;
  remPct: number;
  lightPct: number;
  awakePct: number;
  efficiency: number;
  rollingAvgDuration: number | null;
}

export interface SleepAnalyticsResult {
  nightly: SleepNightlyRow[];
  sleepDebt: number;
}

export interface WorkloadRow {
  date: string;
  dailyLoad: number;
  strain: number;
  acuteLoad: number;
  chronicLoad: number;
  workloadRatio: number | null;
}

export interface HeartRateVariabilityRow {
  date: string;
  hrv: number | null;
  rollingCoefficientOfVariation: number | null;
  rollingMean: number | null;
}

export interface StressResult {
  daily: Array<{
    date: string;
    stressScore: number;
  }>;
  weekly: Array<{
    weekStart: string;
    cumulativeStress: number;
    avgDailyStress: number;
    highStressDays: number;
  }>;
  latestScore: number | null;
  trend: "improving" | "worsening" | "stable";
}

export interface SleepConsistencyRow {
  date: string;
  bedtimeHour: number;
  waketimeHour: number;
  rollingBedtimeStddev: number | null;
  rollingWaketimeStddev: number | null;
  consistencyScore: number | null;
}

// ── Zod schemas for untyped tRPC endpoints (raw SQL results) ──

export const ActivityRowSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string().nullable().optional(),
  activity_type: z.string().nullable().optional(),
  started_at: z.string(),
  ended_at: z.string().nullable().optional(),
  avg_hr: z.number().nullable().optional(),
  max_hr: z.number().nullable().optional(),
  avg_power: z.number().nullable().optional(),
  distance_meters: z.number().nullable().optional(),
  calories: z.number().nullable().optional(),
});

export type ActivityRow = z.infer<typeof ActivityRowSchema>;

export const WeeklyVolumeRowSchema = z.object({
  week: z.string(),
  activity_type: z.string(),
  count: z.number(),
  hours: z.coerce.number(),
});

export type WeeklyVolumeRow = z.infer<typeof WeeklyVolumeRowSchema>;

export const FoodEntrySchema = z.object({
  id: z.string(),
  food_name: z.string(),
  food_description: z.string().nullable(),
  meal: z.string(),
  calories: z.number().nullable(),
  protein_g: z.number().nullable(),
  carbs_g: z.number().nullable(),
  fat_g: z.number().nullable(),
});

export type FoodEntryRow = z.infer<typeof FoodEntrySchema>;
