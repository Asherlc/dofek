import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import {
  clickHouseDateRangePredicate,
  type RangeDays,
  rangeDaysParams,
} from "../lib/date-window.ts";
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
  date: dateStringSchema,
  recorded_at: timestampStringSchema,
  weight_kg: z.coerce.number().nullable(),
  body_fat_pct: z.coerce.number().nullable(),
});

export const bodyCompProvenanceClickHouseSchema = bodyCompClickHouseSchema.extend({
  provider_id: z.string(),
  source_providers: z.array(z.string()),
});

export const bodyWeightClickHouseSchema = z.object({
  date: dateStringSchema,
  weight_kg: z.coerce.number(),
  body_fat_pct: z.coerce.number().nullable(),
});

export const bodyDecisionMeasurementClickHouseSchema = z.object({
  date: dateStringSchema,
  recorded_at: timestampStringSchema,
  recorded_at_local: z.string(),
  weight_kg: z.coerce.number(),
  provider_id: z.string(),
  source_name: z.string().nullable(),
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
  return endDate === "now"
    ? "toDate(toTimeZone(now(), {timezone:String}))"
    : "toDate({endDate:String})";
}

function accessWindowDateClause(
  accessWindow: AccessWindow | undefined,
  localDateExpression = "local_date",
): string {
  if (!accessWindow || accessWindow.kind === "full") return "";
  return `AND ${localDateExpression} >= toDate({accessStart:String}) AND ${localDateExpression} < toDate({accessEnd:String})`;
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
  days: RangeDays,
  options: BodyWeightOptions = {},
): string {
  const localDateRangePredicate = clickHouseDateRangePredicate({
    expression: "toDate(toTimeZone(recorded_at, {timezone:String}))",
    days,
    endDateExpression: endDateExpression(endDate),
  });
  return `
    SELECT
      toString(local_date) AS date,
      weight_kg,
      body_fat_pct
    FROM (
      SELECT
        local_date,
        argMin(weight_kg, (recorded_at, refresh_version, measurement_id)) AS weight_kg,
        argMin(body_fat_pct, (recorded_at, refresh_version, measurement_id)) AS body_fat_pct
      FROM (
        SELECT
          toDate(toTimeZone(recorded_at, {timezone:String})) AS local_date,
          weight_kg,
          body_fat_pct,
          recorded_at,
          refresh_version,
          measurement_id
        FROM analytics.daily_body_measurement FINAL
        WHERE user_id = {userId:UUID}
          AND is_deleted = 0
          AND toDate(toTimeZone(recorded_at, {timezone:String})) <= ${endDateExpression(endDate)}
          ${localDateRangePredicate}
          ${options.requireBodyFat ? "AND body_fat_pct IS NOT NULL" : ""}
      ) AS body_rows
      GROUP BY local_date
    )
    WHERE weight_kg IS NOT NULL
      AND weight_kg > 0
      ${options.requireBodyFat ? "AND body_fat_pct IS NOT NULL" : ""}
      ${accessWindowDateClause(options.accessWindow)}
    ORDER BY local_date ASC
  `;
}

export async function fetchBodyWeightRows(
  store: BodyClickHouseStore,
  userId: string,
  timezone: string,
  endDate: string,
  days: RangeDays,
  options: BodyWeightOptions = {},
): Promise<z.infer<typeof bodyWeightClickHouseSchema>[]> {
  return store.query(
    bodyWeightClickHouseSchema,
    bodyWeightDedupClickHouseQuery(endDate, days, options),
    {
      userId,
      timezone,
      endDate,
      ...rangeDaysParams(days),
      ...accessWindowParams(options.accessWindow),
    },
  );
}

export async function fetchBodyDecisionMeasurements(
  store: BodyClickHouseStore,
  userId: string,
  timezone: string,
  endDate: string,
  accessWindow?: AccessWindow,
): Promise<z.infer<typeof bodyDecisionMeasurementClickHouseSchema>[]> {
  const localDateExpression = "toDate(toTimeZone(body_measurement.recorded_at, {timezone:String}))";
  return store.query(
    bodyDecisionMeasurementClickHouseSchema,
    `
      SELECT
        toString(${localDateExpression}) AS date,
        formatDateTime(body_measurement.recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at,
        formatDateTime(body_measurement.recorded_at, '%Y-%m-%d %H:%i:%S', {timezone:String}) AS recorded_at_local,
        body_measurement.weight_kg AS weight_kg,
        body_measurement.provider_id AS provider_id,
        body_measurement.source_name AS source_name
      FROM analytics.v_body_measurement AS body_measurement
      WHERE body_measurement.user_id = {userId:UUID}
        AND body_measurement.weight_kg IS NOT NULL
        AND body_measurement.weight_kg > 0
        AND ${localDateExpression} <= ${endDateExpression(endDate)}
        ${accessWindowDateClause(accessWindow, localDateExpression)}
      ORDER BY ${localDateExpression} ASC, body_measurement.recorded_at ASC
    `,
    { userId, timezone, endDate, ...accessWindowParams(accessWindow) },
  );
}

export async function fetchBodyCompRows(
  store: BodyClickHouseStore,
  userId: string,
  timezone: string,
  endDate: string,
  days: RangeDays,
): Promise<z.infer<typeof bodyCompClickHouseSchema>[]> {
  const rows = await fetchBodyCompProvenanceRows(store, userId, timezone, endDate, days);
  return rows.map((row) => bodyCompClickHouseSchema.parse(row));
}

export async function fetchBodyCompProvenanceRows(
  store: BodyClickHouseStore,
  userId: string,
  timezone: string,
  endDate: string,
  days: RangeDays,
): Promise<z.infer<typeof bodyCompProvenanceClickHouseSchema>[]> {
  const localDateExpression = "toDate(toTimeZone(recorded_at, {timezone:String}))";
  const localDateRangePredicate = clickHouseDateRangePredicate({
    expression: localDateExpression,
    days,
    endDateExpression: endDateExpression(endDate),
  });
  return store.query(
    bodyCompProvenanceClickHouseSchema,
    `
      SELECT
        toString(toDate(toTimeZone(body_measurements.recorded_at, {timezone:String}))) AS date,
        formatDateTime(body_measurements.recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at,
        body_measurements.provider_id AS provider_id,
        body_measurements.source_providers AS source_providers,
        weight_kg,
        body_fat_pct
      FROM (
        SELECT
          recorded_at,
          provider_id,
          source_providers,
          weight_kg,
          body_fat_pct
        FROM analytics.v_body_measurement
        WHERE user_id = {userId:UUID}
          AND (weight_kg IS NULL OR weight_kg > 0)
          AND ${localDateExpression} <= ${endDateExpression(endDate)}
          ${localDateRangePredicate}
      ) AS body_measurements
      ORDER BY body_measurements.recorded_at ASC
    `,
    { userId, timezone, endDate, ...rangeDaysParams(days) },
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
        AND weight_kg > 0
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
          AND (weight_kg IS NULL OR weight_kg > 0)
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
