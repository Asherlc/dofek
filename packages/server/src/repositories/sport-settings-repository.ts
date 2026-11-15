import { formatDateYmdInTimeZone } from "@dofek/format/format";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const sportSettingsDbSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  sport: z.string(),
  threshold_hr: z.coerce.number().nullable(),
  threshold_pace_per_km: z.coerce.number().nullable(),
  ftp: z.coerce.number().nullable(),
  power_zone_pcts: z.unknown().nullable(),
  hr_zone_pcts: z.unknown().nullable(),
  pace_zone_pcts: z.unknown().nullable(),
  effective_from: z.string(),
  notes: z.string().nullable(),
  created_at: timestampStringSchema,
  updated_at: timestampStringSchema,
});

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface SportSettingsRow {
  id: string;
  userId: string;
  sport: string;
  thresholdHr: number | null;
  thresholdPacePerKm: number | null;
  ftp: number | null;
  powerZonePcts: unknown;
  hrZonePcts: unknown;
  paceZonePcts: unknown;
  effectiveFrom: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function toDomain(row: z.infer<typeof sportSettingsDbSchema>): SportSettingsRow {
  return {
    id: row.id,
    userId: row.user_id,
    sport: row.sport,
    thresholdHr: row.threshold_hr,
    thresholdPacePerKm: row.threshold_pace_per_km,
    ftp: row.ftp,
    powerZonePcts: row.power_zone_pcts,
    hrZonePcts: row.hr_zone_pcts,
    paceZonePcts: row.pace_zone_pcts,
    effectiveFrom: row.effective_from,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Upsert input
// ---------------------------------------------------------------------------

export interface UpsertSportSettings {
  sport: string;
  thresholdHr?: number | null;
  thresholdPacePerKm?: number | null;
  ftp?: number | null;
  powerZonePcts?: number[] | null;
  hrZonePcts?: number[] | null;
  paceZonePcts?: number[] | null;
  effectiveFrom?: string;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for per-sport zone / threshold settings. */
export class SportSettingsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone = "UTC") {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** Most recent setting effective on the user's current local date per sport. */
  async list(): Promise<SportSettingsRow[]> {
    const asOfDate = formatDateYmdInTimeZone(new Date(), this.#timezone);
    const rows = await executeWithSchema(
      this.#db,
      sportSettingsDbSchema,
      sql`
        SELECT DISTINCT ON (sport) *
        FROM fitness.sport_settings
        WHERE user_id = ${this.#userId}
          AND effective_from <= ${asOfDate}::date
        ORDER BY sport, effective_from DESC
      `,
    );
    return rows.map(toDomain);
  }

  /**
   * Get setting for a specific sport, effective on or before the given date.
   * Returns `null` when no matching setting exists.
   */
  async getBySport(sport: string, asOfDate?: string): Promise<SportSettingsRow | null> {
    const asOf = asOfDate ?? formatDateYmdInTimeZone(new Date(), this.#timezone);
    const rows = await executeWithSchema(
      this.#db,
      sportSettingsDbSchema,
      sql`
        SELECT *
        FROM fitness.sport_settings
        WHERE user_id = ${this.#userId}
          AND sport = ${sport}
          AND effective_from <= ${asOf}::date
        ORDER BY effective_from DESC
        LIMIT 1
      `,
    );
    return rows[0] ? toDomain(rows[0]) : null;
  }

  /** Full history of settings for a sport, newest first. */
  async history(sport: string): Promise<SportSettingsRow[]> {
    const rows = await executeWithSchema(
      this.#db,
      sportSettingsDbSchema,
      sql`
        SELECT *
        FROM fitness.sport_settings
        WHERE user_id = ${this.#userId}
          AND sport = ${sport}
        ORDER BY effective_from DESC
      `,
    );
    return rows.map(toDomain);
  }

  /** Insert or update (on user+sport+effective_from conflict). */
  async upsert(settings: UpsertSportSettings): Promise<SportSettingsRow> {
    const effectiveFrom =
      settings.effectiveFrom ?? formatDateYmdInTimeZone(new Date(), this.#timezone);
    const powerZonePcts = jsonbValue(settings.powerZonePcts);
    const hrZonePcts = jsonbValue(settings.hrZonePcts);
    const paceZonePcts = jsonbValue(settings.paceZonePcts);

    const rows = await executeWithSchema(
      this.#db,
      sportSettingsDbSchema,
      sql`
        WITH previous AS (
          SELECT threshold_hr, threshold_pace_per_km, ftp,
                 power_zone_pcts, hr_zone_pcts, pace_zone_pcts, notes
          FROM fitness.sport_settings
          WHERE user_id = ${this.#userId}
            AND sport = ${settings.sport}
            AND effective_from <= ${effectiveFrom}::date
          ORDER BY effective_from DESC
          LIMIT 1
        )
        INSERT INTO fitness.sport_settings (
          user_id, sport, threshold_hr, threshold_pace_per_km, ftp,
          power_zone_pcts, hr_zone_pcts, pace_zone_pcts,
          effective_from, notes
        )
        SELECT
          ${this.#userId},
          ${settings.sport},
          CASE WHEN ${settings.thresholdHr !== undefined} THEN ${settings.thresholdHr ?? null}::smallint ELSE previous.threshold_hr END,
          CASE WHEN ${settings.thresholdPacePerKm !== undefined} THEN ${settings.thresholdPacePerKm ?? null}::real ELSE previous.threshold_pace_per_km END,
          CASE WHEN ${settings.ftp !== undefined} THEN ${settings.ftp ?? null}::integer ELSE previous.ftp END,
          CASE WHEN ${settings.powerZonePcts !== undefined} THEN ${powerZonePcts}::jsonb ELSE previous.power_zone_pcts END,
          CASE WHEN ${settings.hrZonePcts !== undefined} THEN ${hrZonePcts}::jsonb ELSE previous.hr_zone_pcts END,
          CASE WHEN ${settings.paceZonePcts !== undefined} THEN ${paceZonePcts}::jsonb ELSE previous.pace_zone_pcts END,
          ${effectiveFrom}::date,
          CASE WHEN ${settings.notes !== undefined} THEN ${settings.notes ?? null} ELSE previous.notes END
        FROM (SELECT 1) AS seed
        LEFT JOIN previous ON true
        ON CONFLICT (user_id, sport, effective_from)
        DO UPDATE SET
          threshold_hr = CASE WHEN ${settings.thresholdHr !== undefined} THEN EXCLUDED.threshold_hr ELSE sport_settings.threshold_hr END,
          threshold_pace_per_km = CASE WHEN ${settings.thresholdPacePerKm !== undefined} THEN EXCLUDED.threshold_pace_per_km ELSE sport_settings.threshold_pace_per_km END,
          ftp = CASE WHEN ${settings.ftp !== undefined} THEN EXCLUDED.ftp ELSE sport_settings.ftp END,
          power_zone_pcts = CASE WHEN ${settings.powerZonePcts !== undefined} THEN EXCLUDED.power_zone_pcts ELSE sport_settings.power_zone_pcts END,
          hr_zone_pcts = CASE WHEN ${settings.hrZonePcts !== undefined} THEN EXCLUDED.hr_zone_pcts ELSE sport_settings.hr_zone_pcts END,
          pace_zone_pcts = CASE WHEN ${settings.paceZonePcts !== undefined} THEN EXCLUDED.pace_zone_pcts ELSE sport_settings.pace_zone_pcts END,
          notes = CASE WHEN ${settings.notes !== undefined} THEN EXCLUDED.notes ELSE sport_settings.notes END,
          updated_at = NOW()
        RETURNING *
      `,
    );

    const row = rows[0];
    if (!row) throw new Error("INSERT/UPDATE RETURNING returned no rows");
    return toDomain(row);
  }

  /** Delete a setting by ID (scoped to the user). */
  async delete(id: string): Promise<{ success: boolean }> {
    await this.#db.execute(sql`
      DELETE FROM fitness.sport_settings
      WHERE id = ${id}::uuid AND user_id = ${this.#userId}
    `);
    return { success: true };
  }
}

function jsonbValue(value: number[] | null | undefined) {
  return value === null || value === undefined ? sql`NULL` : sql`${JSON.stringify(value)}`;
}
