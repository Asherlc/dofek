import { z } from "zod";

export type TimeRangeDays = number | null;

const persistedTimeRangePreferenceSchema = z.union([
  z.literal("all"),
  z.enum(["7", "14", "30", "90", "180", "365"]).transform(Number),
]);

export const TIME_RANGE_POLICIES = {
  body: {
    defaultDays: 30,
    description: "Recommended default: 30 days keeps recent body changes visible.",
  },
  recovery: {
    defaultDays: 30,
    description: "Recommended default: 30 days keeps recent recovery changes visible.",
  },
  sleep: {
    defaultDays: 30,
    description: "Recommended default: 30 days keeps recent sleep patterns visible.",
  },
  training: {
    defaultDays: 90,
    description:
      "Recommended default: 90 days balances recent training changes with enough history.",
  },
  nutrition: {
    defaultDays: 90,
    description:
      "Recommended default: 90 days provides enough intake and weight history for stable trends.",
  },
  behavior: {
    defaultDays: 90,
    description:
      "Recommended default: 90 days provides enough journal observations to compare patterns.",
  },
  correlation: {
    defaultDays: 365,
    description:
      "Recommended default: 1 year provides enough paired observations for longer-term relationships.",
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
