import { z } from "zod";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { type BodyClickHouseStore, bodyMeasurementClickHouseSchema } from "./body-clickhouse.ts";

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface BodyMeasurementRow {
  id: string;
  recordedAt: string;
  providerId: string;
  userId: string;
  externalId: string | null;
  weightKg: number | null;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
  boneMassKg: number | null;
  waterPct: number | null;
  bmi: number | null;
  heightCm: number | null;
  waistCircumferenceCm: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  heartPulse: number | null;
  temperatureC: number | null;
  sourceName: string | null;
  createdAt: string;
}

const reconciledBodySourceRowSchema = z.object({
  date: dateStringSchema,
  recorded_at: timestampStringSchema,
  provider_id: z.string(),
  body_priority: z.coerce.number().int(),
  weight_kg: z.coerce.number().nullable(),
  body_fat_pct: z.coerce.number().nullable(),
  bmi: z.coerce.number().nullable(),
});

type ReconciledBodySourceRow = z.infer<typeof reconciledBodySourceRowSchema>;

export interface ReconciledBodyDay {
  date: string;
  weightKg: number | null;
  bodyFatPct: number | null;
  leanMassKg: number | null;
  bmi: number | null;
  sourceProviderByMetric: {
    weightKg: string | null;
    bodyFatPct: string | null;
    bmi: string | null;
  };
  sources: Array<{
    sourceProvider: string;
    recordedAt: string;
    weightKg: number | null;
    bodyFatPct: number | null;
    bmi: number | null;
  }>;
  coverage: { sourceCount: number };
}

function preferredMetric(
  rows: ReconciledBodySourceRow[],
  metric: "weight_kg" | "body_fat_pct" | "bmi",
): { value: number | null; provider: string | null } {
  const selected = rows.find((row) => row[metric] !== null);
  return selected
    ? { value: selected[metric], provider: selected.provider_id }
    : { value: null, provider: null };
}

/** A single body measurement record from any provider. */
export class BodyMeasurement {
  readonly #row: BodyMeasurementRow;

  constructor(row: BodyMeasurementRow) {
    this.#row = row;
  }

  get id(): string {
    return this.#row.id;
  }

  get recordedAt(): string {
    return this.#row.recordedAt;
  }

  get weightKg(): number | null {
    return this.#row.weightKg;
  }

  get bodyFatPct(): number | null {
    return this.#row.bodyFatPct;
  }

  get providerId(): string {
    return this.#row.providerId;
  }

  get bmi(): number | null {
    return this.#row.bmi;
  }

  toDetail() {
    return { ...this.#row };
  }
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

/** Data access for body measurement records. */
export class BodyRepository {
  readonly #store: BodyClickHouseStore;
  readonly #userId: string;
  readonly #timezone: string;
  constructor(store: BodyClickHouseStore, userId: string, timezone: string) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** All body measurements within the given day window, newest first. */
  async list(days: number): Promise<BodyMeasurement[]> {
    if (!Number.isInteger(days) || days < 0) {
      throw new Error("days must be a non-negative integer");
    }

    const rows = await this.#store.query(
      bodyMeasurementClickHouseSchema,
      `
        SELECT
          toString(id) AS id,
          toString(body_measurements.recorded_at) AS recorded_at,
          provider_id,
          toString(user_id) AS user_id,
          external_id,
          weight_kg,
          body_fat_pct,
          muscle_mass_kg,
          bone_mass_kg,
          water_pct,
          bmi,
          height_cm,
          waist_circumference_cm,
          systolic_bp,
          diastolic_bp,
          heart_pulse,
          temperature_c,
          source_name,
          toString(created_at) AS created_at
        FROM (
          SELECT
            id,
            recorded_at,
            provider_id,
            user_id,
            external_id,
            weight_kg,
            body_fat_pct,
            muscle_mass_kg,
            bone_mass_kg,
            water_pct,
            bmi,
            height_cm,
            waist_circumference_cm,
            systolic_bp,
            diastolic_bp,
            heart_pulse,
            temperature_c,
            source_name,
            created_at
          FROM analytics.v_body_measurement
          WHERE user_id = {userId:UUID}
            AND recorded_at > now() - toIntervalDay({days:UInt32})
        ) AS body_measurements
        ORDER BY body_measurements.recorded_at DESC
      `,
      { userId: this.#userId, days },
    );

    return rows.map(
      (row) =>
        new BodyMeasurement({
          id: row.id,
          recordedAt: row.recorded_at,
          providerId: row.provider_id,
          userId: row.user_id,
          externalId: row.external_id,
          weightKg: row.weight_kg,
          bodyFatPct: row.body_fat_pct,
          muscleMassKg: row.muscle_mass_kg,
          boneMassKg: row.bone_mass_kg,
          waterPct: row.water_pct,
          bmi: row.bmi,
          heightCm: row.height_cm,
          waistCircumferenceCm: row.waist_circumference_cm,
          systolicBp: row.systolic_bp,
          diastolicBp: row.diastolic_bp,
          heartPulse: row.heart_pulse,
          temperatureC: row.temperature_c,
          sourceName: row.source_name,
          createdAt: row.created_at,
        }),
    );
  }

  /** Body measurements inside an exact inclusive local-date range. */
  async listRange(startDate: string, endDate: string): Promise<BodyMeasurement[]> {
    const rows = await this.#store.query(
      bodyMeasurementClickHouseSchema,
      `
        SELECT
          toString(id) AS id,
          toString(body_measurements.recorded_at) AS recorded_at,
          provider_id,
          toString(user_id) AS user_id,
          external_id,
          weight_kg,
          body_fat_pct,
          muscle_mass_kg,
          bone_mass_kg,
          water_pct,
          bmi,
          height_cm,
          waist_circumference_cm,
          systolic_bp,
          diastolic_bp,
          heart_pulse,
          temperature_c,
          source_name,
          toString(created_at) AS created_at
        FROM (
          SELECT
            id,
            recorded_at,
            provider_id,
            user_id,
            external_id,
            weight_kg,
            body_fat_pct,
            muscle_mass_kg,
            bone_mass_kg,
            water_pct,
            bmi,
            height_cm,
            waist_circumference_cm,
            systolic_bp,
            diastolic_bp,
            heart_pulse,
            temperature_c,
            source_name,
            created_at,
            row_number() OVER (
              PARTITION BY provider_id, toDate(toTimeZone(recorded_at, {timezone:String}))
              ORDER BY recorded_at DESC, created_at DESC
            ) AS row_number
            FROM analytics.v_body_measurement
            WHERE user_id = {userId:UUID}
              AND toDate(toTimeZone(recorded_at, {timezone:String})) >= toDate({startDate:String})
              AND toDate(toTimeZone(recorded_at, {timezone:String})) <= toDate({endDate:String})
        ) AS body_measurements
        WHERE row_number = 1
        ORDER BY body_measurements.recorded_at ASC
      `,
      { userId: this.#userId, timezone: this.#timezone, startDate, endDate },
    );

    return rows.map(
      (row) =>
        new BodyMeasurement({
          id: row.id,
          recordedAt: row.recorded_at,
          providerId: row.provider_id,
          userId: row.user_id,
          externalId: row.external_id,
          weightKg: row.weight_kg,
          bodyFatPct: row.body_fat_pct,
          muscleMassKg: row.muscle_mass_kg,
          boneMassKg: row.bone_mass_kg,
          waterPct: row.water_pct,
          bmi: row.bmi,
          heightCm: row.height_cm,
          waistCircumferenceCm: row.waist_circumference_cm,
          systolicBp: row.systolic_bp,
          diastolicBp: row.diastolic_bp,
          heartPulse: row.heart_pulse,
          temperatureC: row.temperature_c,
          sourceName: row.source_name,
          createdAt: row.created_at,
        }),
    );
  }

  /** One reconciled body-composition record per local date, plus every contributing source. */
  async listReconciledRange(startDate: string, endDate: string): Promise<ReconciledBodyDay[]> {
    const rows = await this.#store.query(
      reconciledBodySourceRowSchema,
      `
        WITH active_provider_priority AS (
          SELECT provider_id, priority, body_priority
          FROM postgres_fitness.provider_priority FINAL
          WHERE _peerdb_is_deleted = 0
        ),
        raw_body_samples AS (
          SELECT
            id,
            toDate(toTimeZone(recorded_at, {timezone:String})) AS local_date,
            recorded_at,
            provider_id,
            channel,
            scalar,
            _peerdb_synced_at AS sample_refreshed_at
          FROM analytics.body_measurement_sample FINAL
          WHERE user_id = {userId:UUID}
            AND _peerdb_is_deleted = 0
            AND scalar IS NOT NULL
            AND channel IN ('body_weight', 'body_fat_percentage', 'body_mass_index')
            AND toDate(toTimeZone(recorded_at, {timezone:String}))
              BETWEEN toDate({startDate:String}) AND toDate({endDate:String})
        ),
        source_measurements AS (
          SELECT
            raw_body_samples.local_date AS local_date,
            raw_body_samples.provider_id AS provider_id,
            coalesce(
              active_provider_priority.body_priority,
              active_provider_priority.priority,
              100
            ) AS body_priority,
            max(raw_body_samples.recorded_at) AS recorded_at,
            argMaxIf(
              raw_body_samples.scalar,
              (
                raw_body_samples.recorded_at,
                raw_body_samples.sample_refreshed_at,
                toString(raw_body_samples.id)
              ),
              raw_body_samples.channel = 'body_weight'
            ) AS weight_kg,
            argMaxIf(
              raw_body_samples.scalar,
              (
                raw_body_samples.recorded_at,
                raw_body_samples.sample_refreshed_at,
                toString(raw_body_samples.id)
              ),
              raw_body_samples.channel = 'body_fat_percentage'
            ) AS body_fat_pct,
            argMaxIf(
              raw_body_samples.scalar,
              (
                raw_body_samples.recorded_at,
                raw_body_samples.sample_refreshed_at,
                toString(raw_body_samples.id)
              ),
              raw_body_samples.channel = 'body_mass_index'
            ) AS bmi
          FROM raw_body_samples
          LEFT JOIN active_provider_priority
            ON active_provider_priority.provider_id = raw_body_samples.provider_id
          GROUP BY
            raw_body_samples.local_date,
            raw_body_samples.provider_id,
            body_priority
        )
        SELECT
          toString(local_date) AS date,
          formatDateTime(recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at,
          provider_id,
          body_priority,
          weight_kg,
          body_fat_pct,
          bmi
        FROM source_measurements
        ORDER BY local_date ASC, body_priority ASC, provider_id ASC
      `,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        startDate,
        endDate,
      },
    );

    const rowsByDate = new Map<string, ReconciledBodySourceRow[]>();
    for (const row of rows) {
      const dateRows = rowsByDate.get(row.date) ?? [];
      dateRows.push(row);
      rowsByDate.set(row.date, dateRows);
    }

    return [...rowsByDate.entries()].map(([date, dateRows]) => {
      dateRows.sort(
        (left, right) =>
          left.body_priority - right.body_priority ||
          Date.parse(right.recorded_at) - Date.parse(left.recorded_at) ||
          left.provider_id.localeCompare(right.provider_id),
      );
      const weight = preferredMetric(dateRows, "weight_kg");
      const bodyFat = preferredMetric(dateRows, "body_fat_pct");
      const bmi = preferredMetric(dateRows, "bmi");

      return {
        date,
        weightKg: weight.value,
        bodyFatPct: bodyFat.value,
        leanMassKg:
          weight.value !== null && bodyFat.value !== null
            ? Math.round(weight.value * (1 - bodyFat.value / 100) * 10) / 10
            : null,
        bmi: bmi.value,
        sourceProviderByMetric: {
          weightKg: weight.provider,
          bodyFatPct: bodyFat.provider,
          bmi: bmi.provider,
        },
        sources: dateRows.map((row) => ({
          sourceProvider: row.provider_id,
          recordedAt: row.recorded_at,
          weightKg: row.weight_kg,
          bodyFatPct: row.body_fat_pct,
          bmi: row.bmi,
        })),
        coverage: { sourceCount: dateRows.length },
      };
    });
  }
}
