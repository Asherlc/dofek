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
            created_at
          FROM analytics.v_body_measurement
          WHERE user_id = {userId:UUID}
            AND toDate(toTimeZone(recorded_at, {timezone:String})) >= toDate({startDate:String})
            AND toDate(toTimeZone(recorded_at, {timezone:String})) <= toDate({endDate:String})
        ) AS body_measurements
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
}
