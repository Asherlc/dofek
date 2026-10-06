import { z } from "zod";

export type TimeRangeDays = number | null;

const persistedTimeRangePreferenceSchema = z.union([
  z.literal("all"),
  z.enum(["7", "14", "30", "90", "180", "365"]).transform(Number),
]);

export const TIME_RANGE_POLICIES = {
  body: {
    defaultDays: 30,
  },
  recovery: {
    defaultDays: 30,
  },
  sleep: {
    defaultDays: 30,
  },
  training: {
    defaultDays: 90,
  },
  nutrition: {
    defaultDays: 90,
  },
  correlation: {
    defaultDays: 365,
  },
} as const;

export type TimeRangeDomain = keyof typeof TIME_RANGE_POLICIES;

export function timeRangePreferenceKey(domain: TimeRangeDomain): string {
  return `dofek.time-range.${domain}`;
}

export function serializeTimeRangePreference(days: TimeRangeDays): string {
  return days === null ? "all" : String(days);
}

export function parseTimeRangePreference(
  persistedValue: unknown,
  defaultDays: number,
): TimeRangeDays {
  const parsedValue = persistedTimeRangePreferenceSchema.safeParse(persistedValue);
  if (!parsedValue.success) {
    return defaultDays;
  }

  return parsedValue.data === "all" ? null : parsedValue.data;
}
