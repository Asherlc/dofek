export const OTHER_ACTIVITY_TYPE = "__other__";

export interface WeeklyVolumeChartRow {
  week: string;
  activity_type: string;
  count: number;
  hours: number;
}

export interface DailyLoadRow {
  date: string;
  dailyLoad: number;
}

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  cycling: "Cycling",
  running: "Running",
  trail_running: "Trail Running",
  walking: "Walking",
  hiking: "Hiking",
  swimming: "Swimming",
  rowing: "Rowing",
  yoga: "Yoga",
  pilates: "Pilates",
  elliptical: "Elliptical",
  strength: "Strength",
  strength_training: "Strength Training",
  functional_strength: "Functional Strength",
  mountain_biking: "Mountain Biking",
  stair_climbing: "Stair Climbing",
  cross_training: "Cross Training",
  hiit: "HIIT",
  cardio: "Cardio",
  other: "Other",
};

function toTitleCase(value: string): string {
  return value
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === "hiit") return "HIIT";
      return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join(" ");
}

function normalizeActivityType(activityType: string): string {
  const normalized = activityType.trim().toLowerCase();
  if (normalized === OTHER_ACTIVITY_TYPE || normalized === "other") {
    return OTHER_ACTIVITY_TYPE;
  }
  return normalized;
}

export function formatActivityTypeLabel(activityType: string): string {
  const normalized = normalizeActivityType(activityType);
  if (normalized === OTHER_ACTIVITY_TYPE) {
    return "Other";
  }
  return ACTIVITY_TYPE_LABELS[normalized] ?? toTitleCase(normalized);
}

export function collapseWeeklyVolumeActivityTypes(
  rows: WeeklyVolumeChartRow[],
  maxLegendItems = 6,
): WeeklyVolumeChartRow[] {
  if (rows.length === 0) return rows;

  const normalizedRows = rows.map((row) => ({
    ...row,
    activity_type: normalizeActivityType(row.activity_type),
  }));

  const totalsByType = new Map<string, number>();
  for (const row of normalizedRows) {
    totalsByType.set(row.activity_type, (totalsByType.get(row.activity_type) ?? 0) + row.hours);
  }

  const orderedTypes = [...totalsByType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type]) => type);

  const shouldCollapse = orderedTypes.length > maxLegendItems;
  const keepTypes = shouldCollapse
    ? new Set(orderedTypes.slice(0, Math.max(0, maxLegendItems - 1)))
    : new Set(orderedTypes);

  const aggregated = new Map<string, WeeklyVolumeChartRow>();
  for (const row of normalizedRows) {
    const groupedType = keepTypes.has(row.activity_type) ? row.activity_type : OTHER_ACTIVITY_TYPE;
    const key = `${row.week}::${groupedType}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += row.count;
      existing.hours += row.hours;
      continue;
    }
    aggregated.set(key, {
      week: row.week,
      activity_type: groupedType,
      count: row.count,
      hours: row.hours,
    });
  }

  return [...aggregated.values()].sort((a, b) => {
    if (a.week !== b.week) return a.week.localeCompare(b.week);
    return a.activity_type.localeCompare(b.activity_type);
  });
}

/**
 * Pick the daily load row to display in "current strain" UI.
 * If the latest day is a rest day (0 load), fall back to the most recent
 * day with positive load so recent training is still represented.
 */
export function selectRecentDailyLoad(rows: DailyLoadRow[]): DailyLoadRow | null {
  if (rows.length === 0) return null;

  const latest = rows[rows.length - 1];
  if (latest == null) return null;
  if (Number.isFinite(latest.dailyLoad) && latest.dailyLoad > 0) return latest;

  for (let index = rows.length - 2; index >= 0; index -= 1) {
    const row = rows[index];
    if (row != null && Number.isFinite(row.dailyLoad) && row.dailyLoad > 0) {
      return row;
    }
  }

  return latest;
}
