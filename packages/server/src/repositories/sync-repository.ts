import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod row schemas
// ---------------------------------------------------------------------------

const tokenRowSchema = z.object({ provider_id: z.string() });

const lastSyncRowSchema = z.object({
  provider_id: z.string(),
  last_synced: z.string(),
});

const latestErrorRowSchema = z.object({
  provider_id: z.string(),
  error_message: z.string().nullable(),
});

const providerStatsRowSchema = z.object({
  provider_id: z.string(),
  activities: z.coerce.number(),
  daily_metrics: z.coerce.number(),
  sleep_sessions: z.coerce.number(),
  body_measurements: z.coerce.number(),
  food_entries: z.coerce.number(),
  health_events: z.coerce.number(),
  metric_stream: z.coerce.number(),
  nutrition_daily: z.coerce.number(),
  lab_panels: z.coerce.number(),
  lab_results: z.coerce.number(),
  journal_entries: z.coerce.number(),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ProviderToken {
  providerId: string;
}

export interface LastSync {
  providerId: string;
  lastSynced: string;
}

export interface LatestError {
  providerId: string;
  errorMessage: string | null;
}

export interface ProviderStatRow {
  providerId: string;
  activities: number;
  dailyMetrics: number;
  sleepSessions: number;
  bodyMeasurements: number;
  foodEntries: number;
  healthEvents: number;
  metricStream: number;
  nutritionDaily: number;
  labPanels: number;
  labResults: number;
  journalEntries: number;
}

export interface SyncLogRow {
  id: string;
  userId: string;
  providerId: string;
  status: string;
  syncedAt: Date;
  durationMs: number | null;
  recordCount: number | null;
  dataType: string;
  errorMessage: string | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for sync-related DB queries. */
export class SyncRepository {
  readonly #db: Pick<Database, "execute" | "select">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute" | "select">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Get distinct provider IDs that have OAuth tokens for this user. */
  async getConnectedProviderIds(): Promise<ProviderToken[]> {
    const rows = await executeWithSchema(
      this.#db,
      tokenRowSchema,
      sql`SELECT DISTINCT ot.provider_id
          FROM fitness.oauth_token ot
          WHERE ot.user_id = ${this.#userId}`,
    );
    return rows.map((row) => ({ providerId: row.provider_id }));
  }

  /** Get the most recent sync timestamp per provider. */
  async getLastSyncTimes(): Promise<LastSync[]> {
    const rows = await executeWithSchema(
      this.#db,
      lastSyncRowSchema,
      sql`SELECT provider_id, MAX(synced_at) AS last_synced
          FROM fitness.sync_log
          WHERE user_id = ${this.#userId}
          GROUP BY provider_id`,
    );
    return rows.map((row) => ({
      providerId: row.provider_id,
      lastSynced: row.last_synced,
    }));
  }

  /**
   * Get providers whose most recent sync entry is an error.
   * Only returns rows where the latest sync_log entry for a provider is an error.
   */
  async getLatestErrors(): Promise<LatestError[]> {
    const rows = await executeWithSchema(
      this.#db,
      latestErrorRowSchema,
      sql`SELECT DISTINCT ON (provider_id) provider_id, error_message
          FROM fitness.sync_log
          WHERE user_id = ${this.#userId} AND status = 'error'
            AND synced_at = (
              SELECT MAX(synced_at) FROM fitness.sync_log s2
              WHERE s2.provider_id = sync_log.provider_id AND s2.user_id = ${this.#userId}
            )
          ORDER BY provider_id`,
    );
    return rows.map((row) => ({
      providerId: row.provider_id,
      errorMessage: row.error_message,
    }));
  }

  /** Fetch sync logs ordered by most recent first. */
  async getLogs(limit: number): Promise<SyncLogRow[]> {
    const { syncLog } = await import("dofek/db/schema");
    const { desc, eq } = await import("drizzle-orm");

    const rows = await this.#db
      .select()
      .from(syncLog)
      .where(eq(syncLog.userId, this.#userId))
      .orderBy(desc(syncLog.syncedAt))
      .limit(limit);

    return rows satisfies SyncLogRow[];
  }

  /** Per-provider record counts broken down by table. */
  async getProviderStats(): Promise<ProviderStatRow[]> {
    const rows = await executeWithSchema(
      this.#db,
      providerStatsRowSchema,
      sql`SELECT
            p.id AS provider_id,
            (SELECT COUNT(*) FROM fitness.activity row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS activities,
            (SELECT COUNT(*) FROM fitness.daily_metrics row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS daily_metrics,
            (SELECT COUNT(*) FROM fitness.sleep_session row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS sleep_sessions,
            (SELECT COUNT(*) FROM fitness.body_measurement row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS body_measurements,
            (SELECT COUNT(*) FROM fitness.food_entry row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS food_entries,
            (SELECT COUNT(*) FROM fitness.health_event row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS health_events,
            (SELECT COUNT(*) FROM fitness.metric_stream row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS metric_stream,
            (SELECT COUNT(DISTINCT row.date) FROM fitness.food_entry row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS nutrition_daily,
            (SELECT COUNT(*) FROM fitness.lab_panel row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS lab_panels,
            (SELECT COUNT(*) FROM fitness.lab_result row JOIN fitness.lab_panel panel ON panel.id = row.panel_id WHERE panel.user_id = ${this.#userId} AND panel.provider_id = p.id)::int AS lab_results,
            (SELECT COUNT(*) FROM fitness.journal_entry row WHERE row.user_id = ${this.#userId} AND row.provider_id = p.id)::int AS journal_entries
          FROM fitness.provider p
          WHERE p.user_id = ${this.#userId}
          ORDER BY p.id`,
    );

    return rows.map((row) => ({
      providerId: row.provider_id,
      activities: row.activities,
      dailyMetrics: row.daily_metrics,
      sleepSessions: row.sleep_sessions,
      bodyMeasurements: row.body_measurements,
      foodEntries: row.food_entries,
      healthEvents: row.health_events,
      metricStream: row.metric_stream,
      nutritionDaily: row.nutrition_daily,
      labPanels: row.lab_panels,
      labResults: row.lab_results,
      journalEntries: row.journal_entries,
    }));
  }
}
