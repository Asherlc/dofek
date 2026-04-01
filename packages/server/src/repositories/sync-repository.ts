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
  activities: z.string(),
  daily_metrics: z.string(),
  sleep_sessions: z.string(),
  body_measurements: z.string(),
  food_entries: z.string(),
  health_events: z.string(),
  metric_stream: z.string(),
  nutrition_daily: z.string(),
  lab_panels: z.string(),
  lab_results: z.string(),
  journal_entries: z.string(),
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
      sql`
      SELECT
        p.id AS provider_id,
        COALESCE(a.cnt, 0)::text AS activities,
        COALESCE(dm.cnt, 0)::text AS daily_metrics,
        COALESCE(ss.cnt, 0)::text AS sleep_sessions,
        COALESCE(bm.cnt, 0)::text AS body_measurements,
        COALESCE(fe.cnt, 0)::text AS food_entries,
        COALESCE(he.cnt, 0)::text AS health_events,
        COALESCE(ms.cnt, 0)::text AS metric_stream,
        COALESCE(nd.cnt, 0)::text AS nutrition_daily,
        COALESCE(lp.cnt, 0)::text AS lab_panels,
        COALESCE(lr.cnt, 0)::text AS lab_results,
        COALESCE(je.cnt, 0)::text AS journal_entries
      FROM fitness.provider p
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.activity WHERE user_id = ${this.#userId} GROUP BY provider_id) a ON a.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.daily_metrics WHERE user_id = ${this.#userId} GROUP BY provider_id) dm ON dm.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.sleep_session WHERE user_id = ${this.#userId} GROUP BY provider_id) ss ON ss.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.body_measurement WHERE user_id = ${this.#userId} GROUP BY provider_id) bm ON bm.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.food_entry WHERE user_id = ${this.#userId} AND confirmed = true GROUP BY provider_id) fe ON fe.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.health_event WHERE user_id = ${this.#userId} GROUP BY provider_id) he ON he.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.sensor_sample WHERE user_id = ${this.#userId} GROUP BY provider_id) ms ON ms.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.nutrition_daily WHERE user_id = ${this.#userId} GROUP BY provider_id) nd ON nd.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.lab_panel WHERE user_id = ${this.#userId} GROUP BY provider_id) lp ON lp.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.lab_result WHERE user_id = ${this.#userId} GROUP BY provider_id) lr ON lr.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.journal_entry WHERE user_id = ${this.#userId} GROUP BY provider_id) je ON je.provider_id = p.id
      ORDER BY p.id
    `,
    );

    return rows.map((row) => ({
      providerId: row.provider_id,
      activities: Number(row.activities),
      dailyMetrics: Number(row.daily_metrics),
      sleepSessions: Number(row.sleep_sessions),
      bodyMeasurements: Number(row.body_measurements),
      foodEntries: Number(row.food_entries),
      healthEvents: Number(row.health_events),
      metricStream: Number(row.metric_stream),
      nutritionDaily: Number(row.nutrition_daily),
      labPanels: Number(row.lab_panels),
      labResults: Number(row.lab_results),
      journalEntries: Number(row.journal_entries),
    }));
  }
}
