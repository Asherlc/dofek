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

const clickHouseProviderStatsRowSchema = z.object({
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

const bodyMeasurementChannels = [
  "body_weight",
  "body_fat_percentage",
  "muscle_mass",
  "bone_mass",
  "body_water_percentage",
  "body_mass_index",
  "height",
  "waist_circumference",
  "systolic_blood_pressure",
  "diastolic_blood_pressure",
  "heart_pulse",
  "body_temperature",
];

const bodyMeasurementChannelListSql = bodyMeasurementChannels
  .map((channel) => `'${channel}'`)
  .join(",\n      ");

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

interface ProviderStatsClickHouseStore {
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<z.infer<TSchema>[]>;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for sync-related DB queries. */
export class SyncRepository {
  readonly #db: Pick<Database, "execute" | "select">;
  readonly #userId: string;
  readonly #providerStatsStore: ProviderStatsClickHouseStore | undefined;

  constructor(
    db: Pick<Database, "execute" | "select">,
    userId: string,
    providerStatsStore?: ProviderStatsClickHouseStore,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#providerStatsStore = providerStatsStore;
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
    const rows = await this.#getClickHouseProviderStats();

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

  async #getClickHouseProviderStats(): Promise<z.infer<typeof clickHouseProviderStatsRowSchema>[]> {
    if (!this.#providerStatsStore) {
      throw new Error(
        "sync.providerStats requires the ClickHouse provider stats store. Set CLICKHOUSE_URL and retry.",
      );
    }

    const rows = await this.#providerStatsStore.query(
      clickHouseProviderStatsRowSchema,
      `
        WITH
        providers AS (
          SELECT DISTINCT id AS provider_id
          FROM postgres_fitness.provider
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          UNION DISTINCT
          SELECT DISTINCT provider_id
          FROM postgres_fitness.activity
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          UNION DISTINCT
          SELECT DISTINCT provider_id
          FROM postgres_fitness.daily_metrics
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          UNION DISTINCT
          SELECT DISTINCT provider_id
          FROM postgres_fitness.sleep_session
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          UNION DISTINCT
          SELECT DISTINCT provider_id
          FROM postgres_fitness.metric_stream
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          UNION DISTINCT
          SELECT DISTINCT provider_id
          FROM postgres_fitness.food_entry
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          UNION DISTINCT
          SELECT DISTINCT provider_id
          FROM postgres_fitness.health_event
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          UNION DISTINCT
          SELECT DISTINCT provider_id
          FROM postgres_fitness.lab_panel
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          UNION DISTINCT
          SELECT DISTINCT provider_id
          FROM postgres_fitness.lab_result
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          UNION DISTINCT
          SELECT DISTINCT provider_id
          FROM postgres_fitness.journal_entry
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
        ),
        activity_counts AS (
          SELECT provider_id, count() AS count
          FROM postgres_fitness.activity
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        ),
        daily_metric_counts AS (
          SELECT provider_id, count() AS count
          FROM postgres_fitness.daily_metrics
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        ),
        sleep_session_counts AS (
          SELECT provider_id, count() AS count
          FROM postgres_fitness.sleep_session
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        ),
        body_measurement_counts AS (
          SELECT
            provider_id,
            uniqExact(ifNull(
              external_id,
              concat(provider_id, ':', toString(user_id), ':', toString(recorded_at), ':', ifNull(device_id, ''))
            )) AS count
          FROM analytics.body_measurement_sample
          WHERE _peerdb_is_deleted = 0
            AND user_id = {userId:UUID}
            AND channel IN (
              ${bodyMeasurementChannelListSql}
            )
          GROUP BY provider_id
        ),
        metric_stream_counts AS (
          SELECT provider_id, count() AS count
          FROM postgres_fitness.metric_stream
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        ),
        food_entry_counts AS (
          SELECT provider_id, count() AS count
          FROM postgres_fitness.food_entry
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        ),
        health_event_counts AS (
          SELECT provider_id, count() AS count
          FROM postgres_fitness.health_event
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        ),
        nutrition_daily_counts AS (
          SELECT provider_id, uniqExact(date) AS count
          FROM postgres_fitness.food_entry
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        ),
        lab_panel_counts AS (
          SELECT provider_id, count() AS count
          FROM postgres_fitness.lab_panel
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        ),
        lab_result_counts AS (
          SELECT provider_id, count() AS count
          FROM postgres_fitness.lab_result
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        ),
        journal_entry_counts AS (
          SELECT provider_id, count() AS count
          FROM postgres_fitness.journal_entry
          WHERE _peerdb_is_deleted = 0 AND user_id = {userId:UUID}
          GROUP BY provider_id
        )
        SELECT
          providers.provider_id AS provider_id,
          coalesce(activity_counts.count, 0) AS activities,
          coalesce(daily_metric_counts.count, 0) AS daily_metrics,
          coalesce(sleep_session_counts.count, 0) AS sleep_sessions,
          coalesce(body_measurement_counts.count, 0) AS body_measurements,
          coalesce(food_entry_counts.count, 0) AS food_entries,
          coalesce(health_event_counts.count, 0) AS health_events,
          coalesce(metric_stream_counts.count, 0) AS metric_stream,
          coalesce(nutrition_daily_counts.count, 0) AS nutrition_daily,
          coalesce(lab_panel_counts.count, 0) AS lab_panels,
          coalesce(lab_result_counts.count, 0) AS lab_results,
          coalesce(journal_entry_counts.count, 0) AS journal_entries
        FROM providers
        LEFT JOIN activity_counts
          ON activity_counts.provider_id = providers.provider_id
        LEFT JOIN daily_metric_counts
          ON daily_metric_counts.provider_id = providers.provider_id
        LEFT JOIN sleep_session_counts
          ON sleep_session_counts.provider_id = providers.provider_id
        LEFT JOIN body_measurement_counts
          ON body_measurement_counts.provider_id = providers.provider_id
        LEFT JOIN metric_stream_counts
          ON metric_stream_counts.provider_id = providers.provider_id
        LEFT JOIN food_entry_counts
          ON food_entry_counts.provider_id = providers.provider_id
        LEFT JOIN health_event_counts
          ON health_event_counts.provider_id = providers.provider_id
        LEFT JOIN nutrition_daily_counts
          ON nutrition_daily_counts.provider_id = providers.provider_id
        LEFT JOIN lab_panel_counts
          ON lab_panel_counts.provider_id = providers.provider_id
        LEFT JOIN lab_result_counts
          ON lab_result_counts.provider_id = providers.provider_id
        LEFT JOIN journal_entry_counts
          ON journal_entry_counts.provider_id = providers.provider_id
        ORDER BY providers.provider_id
      `,
      { userId: this.#userId },
    );
    return rows;
  }
}
