import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

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

  toDetail() {
    return { ...this.#row };
  }
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const bodyMeasurementDbSchema = z.object({
  id: z.string(),
  recorded_at: z.string(),
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
  created_at: z.string(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for body measurement records. */
export class BodyRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** All body measurements within the given day window, newest first. */
  async list(days: number): Promise<BodyMeasurement[]> {
    const rows = await executeWithSchema(
      this.#db,
      bodyMeasurementDbSchema,
      sql`SELECT * FROM fitness.v_body_measurement
          WHERE user_id = ${this.#userId}
            AND recorded_at > NOW() - ${days}::int * INTERVAL '1 day'
          ORDER BY recorded_at DESC`,
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
