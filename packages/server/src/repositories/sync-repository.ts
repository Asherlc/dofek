import type { Database } from "dofek/db";
import { syncLog } from "dofek/db/schema/events";
import {
  type ProviderAuthFailureReason,
  providerAuthFailureReasonSchema,
} from "dofek/providers/auth-errors";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod row schemas
// ---------------------------------------------------------------------------

const tokenRowSchema = z.object({
  provider_id: z.string(),
  updated_at: z.coerce.date(),
});

const lastSyncRowSchema = z.object({
  provider_id: z.string(),
  last_synced: z.string(),
});

const latestErrorRowSchema = z.object({
  provider_id: z.string(),
  error_message: z.string().nullable(),
  auth_failure_reason: providerAuthFailureReasonSchema.nullable(),
  synced_at: z.coerce.date(),
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

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ProviderConnection {
  providerId: string;
  updatedAt: Date;
}

export interface LastSync {
  providerId: string;
  lastSynced: string;
}

export interface LatestError {
  providerId: string;
  errorMessage: string | null;
  authFailureReason: ProviderAuthFailureReason | null;
  syncedAt: Date;
}

export interface ProviderStatRow {
  providerId: string;
  totalRecords: number;
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
  authFailureReason: string | null;
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

  /** Get provider connections for this user, including push-only sources without tokens. */
  async getConnectedProviderIds(): Promise<ProviderConnection[]> {
    const rows = await executeWithSchema(
      this.#db,
      tokenRowSchema,
      sql`SELECT pc.provider_id, COALESCE(ot.updated_at, pc.created_at) AS updated_at
          FROM fitness.provider_connection pc
          LEFT JOIN fitness.oauth_token ot
            ON ot.user_id = pc.user_id
            AND ot.provider_id = pc.provider_id
          WHERE pc.user_id = ${this.#userId}`,
    );
    return rows.map((row) => ({ providerId: row.provider_id, updatedAt: row.updated_at }));
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
      sql`WITH latest_sync_times AS (
            SELECT provider_id, MAX(synced_at) AS synced_at
            FROM fitness.sync_log
            WHERE user_id = ${this.#userId}
            GROUP BY provider_id
          ),
          latest_sync_log AS (
            SELECT DISTINCT ON (sync_log.provider_id)
              sync_log.provider_id,
              sync_log.status,
              sync_log.error_message,
              sync_log.auth_failure_reason,
              sync_log.synced_at
            FROM fitness.sync_log
            INNER JOIN latest_sync_times
              ON latest_sync_times.provider_id = sync_log.provider_id
              AND latest_sync_times.synced_at = sync_log.synced_at
            WHERE sync_log.user_id = ${this.#userId}
            ORDER BY sync_log.provider_id, (sync_log.status = 'error') DESC, sync_log.id DESC
          )
          SELECT provider_id, error_message, auth_failure_reason, synced_at
          FROM latest_sync_log
          WHERE latest_sync_log.status = 'error'
          ORDER BY provider_id`,
    );
    return rows.map((row) => ({
      providerId: row.provider_id,
      errorMessage: row.error_message,
      authFailureReason: row.auth_failure_reason,
      syncedAt: row.synced_at,
    }));
  }

  /** Fetch sync logs ordered by most recent first. */
  async getLogs(limit: number): Promise<SyncLogRow[]> {
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
      totalRecords:
        row.activities +
        row.daily_metrics +
        row.sleep_sessions +
        row.body_measurements +
        row.food_entries +
        row.health_events +
        row.metric_stream +
        row.nutrition_daily +
        row.lab_panels +
        row.lab_results +
        row.journal_entries,
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
        SELECT
          provider_id,
          activities,
          daily_metrics,
          sleep_sessions,
          body_measurements,
          food_entries,
          health_events,
          metric_stream,
          nutrition_daily,
          lab_panels,
          lab_results,
          journal_entries
        FROM analytics.provider_stats FINAL
        WHERE user_id = {userId:UUID}
          AND is_deleted = 0
        ORDER BY provider_id
      `,
      { userId: this.#userId },
    );
    return rows;
  }
}
