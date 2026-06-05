import { z } from "zod";
import { dateWindowStartString } from "../lib/date-window.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import type { AuthenticatedContext } from "../trpc.ts";

const historyRowSchema = z.object({
  week_start: dateStringSchema,
  avg_rhr: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  avg_vo2max: z.coerce.number().nullable(),
});

const rawRowSchema = z.object({
  avg_sleep_min: z.coerce.number().nullable(),
  bedtime_stddev_min: z.coerce.number().nullable(),
  avg_resting_hr: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  latest_vo2max: z.coerce.number().nullable(),
  weekly_aerobic_min: z.coerce.number().nullable(),
  weekly_high_intensity_min: z.coerce.number().nullable(),
  sessions_per_week: z.coerce.number().nullable(),
  weight_kg: z.coerce.number().nullable(),
  body_fat_pct: z.coerce.number().nullable(),
  weekly_history: z.array(historyRowSchema).nullable(),
});

const healthspanReadModelRowSchema = z.object({
  week_start: dateStringSchema,
  avg_sleep_min: z.coerce.number().nullable(),
  bedtime_stddev_min: z.coerce.number().nullable(),
  avg_resting_hr: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  latest_vo2max: z.coerce.number().nullable(),
  weekly_aerobic_min: z.coerce.number().nullable(),
  weekly_high_intensity_min: z.coerce.number().nullable(),
  sessions_per_week: z.coerce.number().nullable(),
  weight_kg: z.coerce.number().nullable(),
  body_fat_pct: z.coerce.number().nullable(),
});

export type HealthspanRawRow = z.infer<typeof rawRowSchema>;

type HealthspanReadModelRow = z.infer<typeof healthspanReadModelRowSchema>;
type HealthspanRawDataContext = Pick<
  AuthenticatedContext,
  "accessWindow" | "sensorStore" | "timezone" | "userId"
>;

function average(values: Array<number | null>): number | null {
  const presentValues = values.filter((value): value is number => value != null);
  if (presentValues.length === 0) return null;
  return presentValues.reduce((sum, value) => sum + value, 0) / presentValues.length;
}

function latestNonNullValue<TKey extends keyof HealthspanReadModelRow>(
  rows: HealthspanReadModelRow[],
  key: TKey,
): number | null {
  for (let rowIndex = rows.length - 1; rowIndex >= 0; rowIndex -= 1) {
    const value = rows[rowIndex]?.[key];
    if (typeof value === "number") return value;
  }
  return null;
}

function accessWindowClause(ctx: HealthspanRawDataContext): string {
  if (ctx.accessWindow.kind === "full") return "";
  return `
    AND healthspan.week_start >= toDate({accessStartDate:String})
    AND healthspan.week_start + INTERVAL 7 DAY <= toDate({accessEndDateExclusive:String})`;
}

function accessWindowParams(ctx: HealthspanRawDataContext): Record<string, string> {
  if (ctx.accessWindow.kind === "full") return {};
  return {
    accessStartDate: ctx.accessWindow.startDate,
    accessEndDateExclusive: ctx.accessWindow.endDateExclusive,
  };
}

function weeklyActivityAverage(rows: HealthspanReadModelRow[], key: keyof HealthspanReadModelRow) {
  if (!rows.some((row) => typeof row[key] === "number")) return null;
  const total = rows.reduce((sum, row) => {
    const value = row[key];
    return sum + (typeof value === "number" ? value : 0);
  }, 0);
  return total / rows.length;
}

/**
 * Fetch compact weekly Healthspan inputs and aggregate them for the requested window.
 */
export async function fetchHealthspanRawData(
  ctx: HealthspanRawDataContext,
  endDate: string,
  totalDays: number,
): Promise<HealthspanRawRow | null> {
  if (!ctx.sensorStore) return null;

  const rows = await ctx.sensorStore.query(
    healthspanReadModelRowSchema,
    `SELECT
      toString(healthspan.week_start) AS week_start,
      avg_sleep_min,
      bedtime_stddev_min,
      avg_resting_hr,
      avg_steps,
      latest_vo2max,
      weekly_aerobic_min,
      weekly_high_intensity_min,
      sessions_per_week,
      weight_kg,
      body_fat_pct
    FROM analytics.weekly_healthspan AS healthspan FINAL
    WHERE healthspan.user_id = {userId:UUID}
      AND healthspan.week_start > toMonday(toDate({windowStart:String}))
      AND healthspan.week_start <= toMonday(toDate({endDate:String}))
      ${accessWindowClause(ctx)}
    ORDER BY healthspan.week_start ASC`,
    {
      userId: ctx.userId,
      windowStart: dateWindowStartString(endDate, totalDays),
      endDate,
      ...accessWindowParams(ctx),
    },
  );

  if (rows.length === 0) return null;

  const sortedRows = [...rows].sort((firstRow, secondRow) =>
    firstRow.week_start.localeCompare(secondRow.week_start),
  );

  return rawRowSchema.parse({
    avg_sleep_min: average(sortedRows.map((row) => row.avg_sleep_min)),
    bedtime_stddev_min: average(sortedRows.map((row) => row.bedtime_stddev_min)),
    avg_resting_hr: average(sortedRows.map((row) => row.avg_resting_hr)),
    avg_steps: average(sortedRows.map((row) => row.avg_steps)),
    latest_vo2max: latestNonNullValue(sortedRows, "latest_vo2max"),
    weekly_aerobic_min: weeklyActivityAverage(sortedRows, "weekly_aerobic_min"),
    weekly_high_intensity_min: weeklyActivityAverage(sortedRows, "weekly_high_intensity_min"),
    sessions_per_week: weeklyActivityAverage(sortedRows, "sessions_per_week"),
    weight_kg: latestNonNullValue(sortedRows, "weight_kg"),
    body_fat_pct: latestNonNullValue(sortedRows, "body_fat_pct"),
    weekly_history: sortedRows.map((row) => ({
      week_start: row.week_start,
      avg_rhr: row.avg_resting_hr,
      avg_steps: row.avg_steps,
      avg_vo2max: row.latest_vo2max,
    })),
  });
}
