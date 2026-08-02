import { formatDateYmd, formatDateYmdInTimeZone } from "@dofek/format/format";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";

export type RangeDays = number | null;
export type RangeOperator = ">" | ">=";

export const SELECTED_CHART_RANGE_ENDPOINTS = {
  "activity.list": { defaultDays: 30, routerFile: "activity.ts", input: "custom" },
  "behaviorImpact.impactSummary": {
    defaultDays: 90,
    routerFile: "behavior-impact.ts",
    input: "days",
  },
  "bodyAnalytics.recomposition": {
    defaultDays: 180,
    routerFile: "body-analytics.ts",
    input: "dateRange",
  },
  "bodyAnalytics.weightOverview": {
    defaultDays: 90,
    routerFile: "body-analytics.ts",
    input: "dateRange",
  },
  "calendar.calendarData": { defaultDays: 365, routerFile: "calendar.ts", input: "days" },
  "correlation.compute": { defaultDays: 365, routerFile: "correlation.ts", input: "custom" },
  "correlation.computeV2": { defaultDays: 365, routerFile: "correlation.ts", input: "custom" },
  "correlation.observations": { defaultDays: 365, routerFile: "correlation.ts", input: "custom" },
  "cyclingAdvanced.activityVariability": {
    defaultDays: 90,
    routerFile: "cycling-advanced.ts",
    input: "custom",
  },
  "cycling.activities": { defaultDays: 90, routerFile: "cycling.ts", input: "custom" },
  "cycling.performance": { defaultDays: 90, routerFile: "cycling.ts", input: "days" },
  "cyclingAdvanced.rampRate": {
    defaultDays: 90,
    routerFile: "cycling-advanced.ts",
    input: "days",
  },
  "cyclingAdvanced.trainingMonotony": {
    defaultDays: 90,
    routerFile: "cycling-advanced.ts",
    input: "days",
  },
  "cyclingAdvanced.verticalAscentRate": {
    defaultDays: 90,
    routerFile: "cycling-advanced.ts",
    input: "days",
  },
  "cyclingAdvanced.pedalDynamics": {
    defaultDays: 90,
    routerFile: "cycling-advanced.ts",
    input: "days",
  },
  "dailyMetrics.hrvBaseline": {
    defaultDays: 30,
    routerFile: "daily-metrics.ts",
    input: "dateRange",
  },
  "dailyMetrics.list": { defaultDays: 30, routerFile: "daily-metrics.ts", input: "dateRange" },
  "dailyMetrics.trends": { defaultDays: 30, routerFile: "daily-metrics.ts", input: "dateRange" },
  "durationCurves.paceCurve": {
    defaultDays: 90,
    routerFile: "duration-curves.ts",
    input: "days",
  },
  "durationCurves.hrCurve": {
    defaultDays: 90,
    routerFile: "duration-curves.ts",
    input: "days",
  },
  "efficiency.aerobicEfficiency": {
    defaultDays: 180,
    routerFile: "efficiency.ts",
    input: "days",
  },
  "efficiency.aerobicDecoupling": {
    defaultDays: 180,
    routerFile: "efficiency.ts",
    input: "days",
  },
  "efficiency.polarizationTrend": {
    defaultDays: 180,
    routerFile: "efficiency.ts",
    input: "days",
  },
  "hiking.activityComparison": { defaultDays: 365, routerFile: "hiking.ts", input: "days" },
  "hiking.elevationProfile": { defaultDays: 365, routerFile: "hiking.ts", input: "days" },
  "hiking.gradeAdjustedPace": { defaultDays: 90, routerFile: "hiking.ts", input: "days" },
  "hiking.walkingBiomechanics": { defaultDays: 90, routerFile: "hiking.ts", input: "days" },
  "insights.compute": { defaultDays: 90, routerFile: "insights.ts", input: "dateRange" },
  "journal.entries": { defaultDays: 30, routerFile: "journal.ts", input: "days" },
  "journal.trends": { defaultDays: 30, routerFile: "journal.ts", input: "dateRange" },
  "nutritionAnalytics.adaptiveTdee": {
    defaultDays: 90,
    routerFile: "nutrition-analytics.ts",
    input: "days",
  },
  "nutritionAnalytics.macroRatios": {
    defaultDays: 30,
    routerFile: "nutrition-analytics.ts",
    input: "days",
  },
  "nutritionAnalytics.micronutrientAdequacy": {
    defaultDays: 30,
    routerFile: "nutrition-analytics.ts",
    input: "days",
  },
  "nutritionAnalytics.micronutrientAdequacyV2": {
    defaultDays: 30,
    routerFile: "nutrition-analytics.ts",
    input: "days",
  },
  "pmc.chart": { defaultDays: 180, routerFile: "pmc.ts", input: "days" },
  "power.eftpTrend": { defaultDays: 365, routerFile: "power.ts", input: "days" },
  "power.powerCurve": { defaultDays: 90, routerFile: "power.ts", input: "days" },
  "recovery.hrvVariability": { defaultDays: 90, routerFile: "recovery.ts", input: "dateRange" },
  "recovery.readinessScore": { defaultDays: 30, routerFile: "recovery.ts", input: "dateRange" },
  "recovery.sleepAnalytics": { defaultDays: 90, routerFile: "recovery.ts", input: "dateRange" },
  "recovery.workloadRatio": { defaultDays: 90, routerFile: "recovery.ts", input: "dateRange" },
  "running.dynamics": { defaultDays: 90, routerFile: "running.ts", input: "days" },
  "running.paceTrend": { defaultDays: 90, routerFile: "running.ts", input: "days" },
  "sleep.list": { defaultDays: 30, routerFile: "sleep.ts", input: "dateRange" },
  "strength.estimatedOneRepMax": { defaultDays: 90, routerFile: "strength.ts", input: "days" },
  "strength.muscleGroupVolume": { defaultDays: 90, routerFile: "strength.ts", input: "days" },
  "strength.progressiveOverload": { defaultDays: 90, routerFile: "strength.ts", input: "days" },
  "strength.volumeOverTime": { defaultDays: 90, routerFile: "strength.ts", input: "days" },
  "stress.scores": { defaultDays: 90, routerFile: "stress.ts", input: "dateRange" },
  "training.hrZones": { defaultDays: 90, routerFile: "training.ts", input: "days" },
  "training.activityStats": { defaultDays: 90, routerFile: "training.ts", input: "days" },
  "training.weeklyVolume": { defaultDays: 90, routerFile: "training.ts", input: "days" },
} as const;

export type SelectedChartRangeEndpoint = keyof typeof SELECTED_CHART_RANGE_ENDPOINTS;

export function rangeDaysSchema(defaultDays: number, options: { min?: number; max?: number } = {}) {
  let finiteDaysSchema = z
    .number()
    .int()
    .min(options.min ?? 1);
  if (options.max !== undefined) finiteDaysSchema = finiteDaysSchema.max(options.max);
  return finiteDaysSchema.nullable().default(defaultDays);
}

export function selectedChartRangeDaysSchema(
  endpoint: SelectedChartRangeEndpoint,
  options: { min?: number; max?: number } = {},
) {
  return rangeDaysSchema(SELECTED_CHART_RANGE_ENDPOINTS[endpoint].defaultDays, options);
}

export function rangeDaysInput(defaultDays: number) {
  return z.object({ days: rangeDaysSchema(defaultDays) });
}

export function selectedChartRangeInput(
  endpoint: SelectedChartRangeEndpoint,
  options: { min?: number; max?: number } = {},
) {
  return z.object({ days: selectedChartRangeDaysSchema(endpoint, options) });
}

export function selectedDateRangeInput(defaultDays = 30) {
  return z.object({
    days: rangeDaysSchema(defaultDays),
    endDate: endDateSchema,
  });
}

export function selectedChartDateRangeInput(
  endpoint: SelectedChartRangeEndpoint,
  options: { min?: number; max?: number } = {},
) {
  return z.object({
    days: selectedChartRangeDaysSchema(endpoint, options),
    endDate: endDateSchema,
  });
}

/**
 * ISO date string (YYYY-MM-DD) provided by the client.
 * Ensures the client controls the date boundary rather than relying on
 * the server's CURRENT_DATE, which can cause stale cached results
 * when the day rolls over (the cache key wouldn't change because
 * `{ days: 30 }` stays the same even after midnight).
 *
 * Optional — falls back to server's current date if omitted.
 * Dashboard clients SHOULD always pass this to ensure cache invalidation.
 */
export const endDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD date")
  .optional()
  .transform((d) => d ?? formatDateYmd());

/** Standard finite date-windowed input: `days` lookback from `endDate`. */
export const dateWindowInput = z.object({
  days: z.number().default(30),
  endDate: endDateSchema,
});

export function rangeDaysParams(days: RangeDays, parameterName = "days"): Record<string, number> {
  return days === null ? {} : { [parameterName]: days };
}

export function rangeDaysOrNullAdd(days: RangeDays, extraDays: number): RangeDays {
  return days === null ? null : days + extraDays;
}

export function clickHouseRangeLowerBound(
  days: RangeDays,
  column: string,
  parameterName = "days",
): string {
  return days === null ? "" : `AND ${column} > now() - INTERVAL {${parameterName}:Int32} DAY`;
}

export function clickHouseIntervalDayLowerBound(
  days: RangeDays,
  column: string,
  parameterName = "days",
): string {
  return clickHouseRangeLowerBound(days, column, parameterName);
}

export function clickHouseToIntervalDayLowerBound(
  days: RangeDays,
  column: string,
  parameterName = "days",
): string {
  return days === null ? "" : `AND ${column} > now() - toIntervalDay({${parameterName}:UInt32})`;
}

export function clickHouseDateRangeLowerBound(
  days: RangeDays,
  column: string,
  parameterName = "days",
): string {
  return days === null ? "" : `AND ${column} > today() - INTERVAL {${parameterName}:Int32} DAY`;
}

export function clickHouseMondayDateRangeLowerBound(
  days: RangeDays,
  column: string,
  parameterName = "days",
  operator: RangeOperator = ">",
): string {
  return days === null
    ? ""
    : `AND ${column} ${operator} toMonday(today() - INTERVAL {${parameterName}:Int32} DAY)`;
}

export function postgresCurrentTimestampRangeLowerBound(days: RangeDays, column: SQL): SQL {
  if (days === null) return sql``;
  return sql`AND ${column} > CURRENT_TIMESTAMP - ${days}::int * INTERVAL '1 day'`;
}

export function postgresEndDateTimestampRangeLowerBound(
  days: RangeDays,
  column: SQL,
  endDate: string,
): SQL {
  if (days === null) return sql``;
  return sql`AND ${column} > ${timestampWindowStart(endDate, days)}`;
}

export function dateWindowStartStringOrUndefined(
  endDate: string,
  days: RangeDays,
): string | undefined {
  return days === null ? undefined : dateWindowStartString(endDate, days);
}

export function dateWindowStartString(endDate: string, days: number): string {
  const windowStart = new Date(`${endDate}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - days);
  return formatDateYmdInTimeZone(windowStart, "UTC");
}

export function dateWindowEndExclusiveString(endDate: string): string {
  return dateWindowStartString(endDate, -1);
}

/**
 * Build the SQL lower bound for a date window.
 * Replaces `CURRENT_DATE - ${days}::int` with a client-provided anchor.
 *
 * @example
 *   WHERE date > ${dateWindowStart(endDate, days)}
 */
export function dateWindowStart(endDate: string, days: number): SQL {
  return sql`${endDate}::date - ${days}::int`;
}

export function dateWindowStartPredicate(
  column: SQL,
  endDate: string,
  days: RangeDays,
  operator: RangeOperator = ">",
): SQL {
  if (days === null) return sql``;
  return operator === ">="
    ? sql`AND ${column} >= ${dateWindowStart(endDate, days)}`
    : sql`AND ${column} > ${dateWindowStart(endDate, days)}`;
}

/**
 * Build the SQL upper bound for a date window (the endDate itself as a date).
 * Replaces `CURRENT_DATE` with the client-provided anchor.
 *
 * @example
 *   WHERE date <= ${dateWindowEnd(endDate)}
 */
export function dateWindowEnd(endDate: string): SQL {
  return sql`${endDate}::date`;
}

/**
 * Build a SQL timestamp lower bound for a date window.
 * Replaces `NOW() - ${days} * INTERVAL '1 day'`.
 * Uses midnight of (endDate - days) as the cutoff.
 *
 * @example
 *   WHERE started_at > ${timestampWindowStart(endDate, days)}
 */
export function timestampWindowStart(endDate: string, days: number): SQL {
  return sql`(${endDate}::date - ${days}::int)::timestamp`;
}

export function timestampWindowStartPredicate(
  column: SQL,
  endDate: string,
  days: RangeDays,
  operator: RangeOperator = ">",
): SQL {
  if (days === null) return sql``;
  return operator === ">="
    ? sql`AND ${column} >= ${timestampWindowStart(endDate, days)}`
    : sql`AND ${column} > ${timestampWindowStart(endDate, days)}`;
}

export function timestampWindowStartString(endDate: string, days: number): string {
  return `${dateWindowStartString(endDate, days)} 00:00:00`;
}

export function currentDateRangePredicate(
  column: SQL,
  days: RangeDays,
  operator: RangeOperator = ">",
): SQL {
  if (days === null) return sql``;
  return operator === ">="
    ? sql`AND ${column} >= (CURRENT_DATE - ${days}::int)`
    : sql`AND ${column} > CURRENT_DATE - ${days}::int`;
}

export function clickHouseDateRangePredicate(input: {
  expression: string;
  days: RangeDays;
  operator?: RangeOperator;
  endDateExpression?: string;
}): string {
  if (input.days === null) return "";
  const operator = input.operator ?? ">";
  const endDateExpression = input.endDateExpression ?? "toDate({endDate:String})";
  return `AND ${input.expression} ${operator} subtractDays(${endDateExpression}, {days:UInt32})`;
}

export function clickHouseWindowStartPredicate(input: {
  expression: string;
  days: RangeDays;
  operator?: RangeOperator;
  paramName?: string;
}): string {
  if (input.days === null) return "";
  const operator = input.operator ?? ">";
  const paramName = input.paramName ?? "windowStart";
  return `AND ${input.expression} ${operator} toDate({${paramName}:String})`;
}
