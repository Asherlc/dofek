export type TimeRangeDays = number | null;

export const TIME_RANGE_POLICIES = {
  body: {
    defaultDays: 30,
    description: "Default: 30 days keeps recent body changes visible.",
  },
  recovery: {
    defaultDays: 30,
    description: "Default: 30 days keeps recent recovery changes visible.",
  },
  sleep: {
    defaultDays: 30,
    description: "Default: 30 days keeps recent sleep patterns visible.",
  },
  training: {
    defaultDays: 90,
    description: "Default: 90 days balances recent training changes with enough history.",
  },
  nutrition: {
    defaultDays: 90,
    description: "Default: 90 days provides enough intake and weight history for stable trends.",
  },
  behavior: {
    defaultDays: 90,
    description: "Default: 90 days provides enough journal observations to compare patterns.",
  },
  correlation: {
    defaultDays: 365,
    description:
      "Default: 1 year provides enough paired observations for longer-term relationships.",
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
  persistedValue: string | null,
  defaultDays: number,
): TimeRangeDays {
  if (persistedValue === "all") {
    return null;
  }

  if (persistedValue === null || persistedValue.trim() === "") {
    return defaultDays;
  }

  const days = Number(persistedValue);
  return Number.isInteger(days) && days > 0 ? days : defaultDays;
}
