import { parseHealthDate } from "./dates.ts";

export type SleepStage = "inBed" | "core" | "deep" | "rem" | "awake" | "asleep";

export interface SleepAnalysisRecord {
  stage: SleepStage;
  sourceName: string | null;
  startDate: Date;
  endDate: Date;
  durationMinutes: number;
}

export const SLEEP_STAGE_MAP: Record<string, SleepStage> = {
  HKCategoryValueSleepAnalysisInBed: "inBed",
  HKCategoryValueSleepAnalysisAsleepCore: "core",
  HKCategoryValueSleepAnalysisAsleepDeep: "deep",
  HKCategoryValueSleepAnalysisAsleepREM: "rem",
  HKCategoryValueSleepAnalysisAwake: "awake",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "asleep",
  // Legacy numeric values (iOS < 16)
  "0": "inBed",
  "1": "asleep",
  "2": "awake",
};

export function parseSleepAnalysis(attrs: Record<string, string>): SleepAnalysisRecord | null {
  const value = attrs.value;
  if (!value) return null;
  const stage = SLEEP_STAGE_MAP[value];
  if (!stage) return null;

  const startDate = parseHealthDate(attrs.startDate ?? "");
  const endDate = parseHealthDate(attrs.endDate ?? "");
  const durationMinutes = Math.round((endDate.getTime() - startDate.getTime()) / 60000);

  return {
    stage,
    sourceName: attrs.sourceName ?? null,
    startDate,
    endDate,
    durationMinutes,
  };
}
