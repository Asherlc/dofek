import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";

export interface BodyClickHouseStore {
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]>;
}

export const bodyMeasurementClickHouseSchema = z.object({
  id: z.string(),
  recorded_at: timestampStringSchema,
  provider_id: z.string(),
  user_id: z.string(),
  external_id: z.string().nullable(),
  weight_kg: z.coerce.number().nullable(),
  body_fat_pct: z.coerce.number().nullable(),
  muscle_mass_kg: z.coerce.number().nullable(),
  bone_mass_kg: z.coerce.number().nullable(),
  water_pct: z.coerce.number().nullable(),
  bmi: z.coerce.number().nullable(),
  height_cm: z.coerce.number().nullable(),
  waist_circumference_cm: z.coerce.number().nullable(),
  systolic_bp: z.coerce.number().nullable(),
  diastolic_bp: z.coerce.number().nullable(),
  heart_pulse: z.coerce.number().nullable(),
  temperature_c: z.coerce.number().nullable(),
  source_name: z.string().nullable(),
  created_at: timestampStringSchema,
});

export const bodyCompClickHouseSchema = z.object({
  recorded_at: timestampStringSchema,
  weight_kg: z.coerce.number().nullable(),
  body_fat_pct: z.coerce.number().nullable(),
});

export const bodyWeightClickHouseSchema = z.object({
  date: dateStringSchema,
  weight_kg: z.coerce.number(),
  body_fat_pct: z.coerce.number().nullable(),
});

export const bodyLatestClickHouseSchema = z.object({
  weight_kg: z.coerce.number().nullable(),
  body_fat_pct: z.coerce.number().nullable(),
});

export const bodyComparisonClickHouseSchema = z.object({
  period: z.string(),
  measurements: z.coerce.number(),
  avg_weight: z.coerce.number().nullable(),
  avg_body_fat: z.coerce.number().nullable(),
});

type BodyWeightOptions = {
  requireBodyFat?: boolean;
  accessWindow?: AccessWindow;
};

function endDateExpression(endDate: string): string {
  return endDate === "now" ? "today()" : "toDate({endDate:String})";
}

function endTimestampExpression(endDate: string): string {
  return endDate === "now" ? "now()" : "parseDateTimeBestEffort({endDate:String})";
}

function accessWindowDateClause(accessWindow: AccessWindow | undefined): string {
  if (!accessWindow || accessWindow.kind === "full") return "";
  return "AND local_date >= toDate({accessStart:String}) AND local_date < toDate({accessEnd:String})";
}

function accessWindowParams(accessWindow: AccessWindow | undefined): Record<string, unknown> {
  if (!accessWindow || accessWindow.kind === "full") return {};
  return {
    accessStart: accessWindow.startDate,
    accessEnd: accessWindow.endDateExclusive,
  };
}

export function bodyWeightDedupClickHouseQuery(
  endDate: string,
  options: BodyWeightOptions = {},
): string {
  return `
    SELECT
      toString(local_date) AS date,
      weight_kg,
      body_fat_pct
    FROM (
      SELECT
        toDate(toTimeZone(recorded_at, {timezone:String})) AS local_date,
        weight_kg,
        body_fat_pct,
        recorded_at,
        row_number() OVER (
          PARTITION BY toDate(toTimeZone(recorded_at, {timezone:String}))
          ORDER BY recorded_at DESC
        ) AS row_number
      FROM analytics.v_body_measurement
      WHERE user_id = {userId:UUID}
        AND weight_kg IS NOT NULL
        ${options.requireBodyFat ? "AND body_fat_pct IS NOT NULL" : ""}
        AND toDate(toTimeZone(recorded_at, {timezone:String})) > subtractDays(${endDateExpression(endDate)}, {days:UInt32})
    )
    WHERE row_number = 1
      ${accessWindowDateClause(options.accessWindow)}
    ORDER BY local_date ASC
  `;
}

export async function fetchBodyWeightRows(
  store: BodyClickHouseStore,
  userId: string,
  timezone: string,
  endDate: string,
  days: number,
  options: BodyWeightOptions = {},
): Promise<z.infer<typeof bodyWeightClickHouseSchema>[]> {
  return store.query(bodyWeightClickHouseSchema, bodyWeightDedupClickHouseQuery(endDate, options), {
    userId,
    timezone,
    endDate,
    days,
    ...accessWindowParams(options.accessWindow),
  });
}

export async function fetchBodyCompRows(
  store: BodyClickHouseStore,
  userId: string,
  endDate: string,
  days: number,
): Promise<z.infer<typeof bodyCompClickHouseSchema>[]> {
  return store.query(
    bodyCompClickHouseSchema,
    `
      SELECT
        toString(body_measurements.recorded_at) AS recorded_at,
        weight_kg,
        body_fat_pct
      FROM (
        SELECT
          recorded_at,
          weight_kg,
          body_fat_pct
        FROM analytics.v_body_measurement
        WHERE user_id = {userId:UUID}
          AND recorded_at > subtractDays(${endTimestampExpression(endDate)}, {days:UInt32})
      ) AS body_measurements
      ORDER BY body_measurements.recorded_at ASC
    `,
    { userId, endDate, days },
  );
}

export async function fetchLatestBodyMeasurement(
  store: BodyClickHouseStore,
  userId: string,
): Promise<z.infer<typeof bodyLatestClickHouseSchema> | null> {
  const rows = await store.query(
    bodyLatestClickHouseSchema,
    `
      SELECT weight_kg, body_fat_pct
      FROM analytics.v_body_measurement
      WHERE user_id = {userId:UUID}
        AND weight_kg IS NOT NULL
      ORDER BY recorded_at DESC
      LIMIT 1
    `,
    { userId },
  );
  return rows[0] ?? null;
}

export async function fetchBodyComparisonRows(
  store: BodyClickHouseStore,
  userId: string,
  timezone: string,
  startDate: string,
  endDate: string | null,
  windowDays: number,
): Promise<z.infer<typeof bodyComparisonClickHouseSchema>[]> {
  const normalizedEndDate = endDate?.toLowerCase();
  const afterEndClause =
    endDate === null
      ? "AND local_date <= addDays(toDate({startDate:String}), {windowDays:UInt32})"
      : normalizedEndDate === "now" || normalizedEndDate === "now()"
        ? "AND local_date <= today()"
        : "AND local_date <= toDate({endDate:String})";

  return store.query(
    bodyComparisonClickHouseSchema,
    `
      WITH body_rows AS (
        SELECT
          toDate(toTimeZone(recorded_at, {timezone:String})) AS local_date,
          weight_kg,
          body_fat_pct
        FROM analytics.v_body_measurement
        WHERE user_id = {userId:UUID}
      ),
      combined AS (
        SELECT 'before' AS period, weight_kg, body_fat_pct
        FROM body_rows
        WHERE local_date BETWEEN subtractDays(toDate({startDate:String}), {windowDays:UInt32})
          AND subtractDays(toDate({startDate:String}), 1)
        UNION ALL
        SELECT 'after' AS period, weight_kg, body_fat_pct
        FROM body_rows
        WHERE local_date >= toDate({startDate:String})
          ${afterEndClause}
      )
      SELECT
        period,
        count() AS measurements,
        avg(weight_kg) AS avg_weight,
        avg(body_fat_pct) AS avg_body_fat
      FROM combined
      GROUP BY period
      ORDER BY period
    `,
    { userId, timezone, startDate, endDate: endDate ?? startDate, windowDays },
  );
}
