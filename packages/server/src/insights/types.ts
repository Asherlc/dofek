import type { CorrelationResult, DescriptiveStats } from "./stats.ts";

// ── Configuration ─────────────────────────────────────────────────────────

export interface InsightsConfig {
  /** Minimum daily calories to consider a nutrition day "complete". Days below this are excluded. */
  minDailyCalories: number;
}

export const DEFAULT_CONFIG: InsightsConfig = {
  minDailyCalories: 1200,
};

// ── Types ─────────────────────────────────────────────────────────────────

export interface DailyRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  date: string | Date;
  resting_hr: number | null;
  hrv: number | null;
  spo2_avg: number | null;
  steps: number | null;
  active_energy_kcal: number | null;
  skin_temp_c: number | null;
}

export interface SleepRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  started_at: string;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  efficiency_pct: number | null;
  is_nap: boolean;
}

export interface ActivityRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  started_at: string;
  ended_at: string | null;
  activity_type: string;
}

export interface NutritionRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  date: string | Date;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  water_ml: number | null;
}

export interface BodyCompRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  recorded_at: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
}

export type ConfidenceLevel = "strong" | "emerging" | "early" | "insufficient";

export interface Insight {
  id: string;
  type: "conditional" | "correlation" | "discovery";
  confidence: ConfidenceLevel;
  metric: string;
  action: string;
  message: string;
  detail: string;
  whenTrue: DescriptiveStats;
  whenFalse: DescriptiveStats;
  effectSize: number;
  pValue: number;
  correlation?: CorrelationResult;
  explanation?: string;
  confounders?: string[];

  /** Raw data points for scatter plot visualization (correlation/discovery types) */
  dataPoints?: Array<{ x: number; y: number; date: string }>;

  /** Distribution data for conditional comparisons */
  distributions?: {
    withAction: number[];
    withoutAction: number[];
  };
}
