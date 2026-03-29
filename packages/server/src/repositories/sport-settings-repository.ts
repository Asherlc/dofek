import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const sportSettingsDbSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  sport: z.string(),
  ftp: z.coerce.number().nullable(),
  threshold_hr: z.coerce.number().nullable(),
  threshold_pace_per_km: z.coerce.number().nullable(),
  power_zone_pcts: z.unknown().nullable(),
  hr_zone_pcts: z.unknown().nullable(),
  pace_zone_pcts: z.unknown().nullable(),
  effective_from: z.string(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface SportSettingsRow {
  id: string;
  userId: string;
  sport: string;
  ftp: number | null;
  thresholdHr: number | null;
  thresholdPacePerKm: number | null;
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
    ftp: row.ftp,
    thresholdHr: row.threshold_hr,
    thresholdPacePerKm: row.threshold_pace_per_km,
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
  ftp?: number | null;
  thresholdHr?: number | null;
  thresholdPacePerKm?: number | null;
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

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Most recent effective setting per sport. */
  async list(): Promise<SportSettingsRow[]> {
    const rows = await executeWithSchema(
      this.#db,
      sportSettingsDbSchema,
      sql`
        SELECT DISTINCT ON (sport) *
        FROM fitness.sport_settings
        WHERE user_id = ${this.#userId}
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
    const asOf = asOfDate ?? new Date().toISOString().slice(0, 10);
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
    const effectiveFrom = settings.effectiveFrom ?? new Date().toISOString().slice(0, 10);

    const rows = await executeWithSchema(
      this.#db,
      sportSettingsDbSchema,
      sql`
        INSERT INTO fitness.sport_settings (
          user_id, sport, ftp, threshold_hr, threshold_pace_per_km,
          power_zone_pcts, hr_zone_pcts, pace_zone_pcts,
          effective_from, notes
        )
        VALUES (
          ${this.#userId},
          ${settings.sport},
          ${settings.ftp ?? null},
          ${settings.thresholdHr ?? null},
          ${settings.thresholdPacePerKm ?? null},
          ${settings.powerZonePcts ? JSON.stringify(settings.powerZonePcts) : null}::jsonb,
          ${settings.hrZonePcts ? JSON.stringify(settings.hrZonePcts) : null}::jsonb,
          ${settings.paceZonePcts ? JSON.stringify(settings.paceZonePcts) : null}::jsonb,
          ${effectiveFrom}::date,
          ${settings.notes ?? null}
        )
        ON CONFLICT (user_id, sport, effective_from)
        DO UPDATE SET
          ftp = EXCLUDED.ftp,
          threshold_hr = EXCLUDED.threshold_hr,
          threshold_pace_per_km = EXCLUDED.threshold_pace_per_km,
          power_zone_pcts = EXCLUDED.power_zone_pcts,
          hr_zone_pcts = EXCLUDED.hr_zone_pcts,
          pace_zone_pcts = EXCLUDED.pace_zone_pcts,
          notes = EXCLUDED.notes,
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
