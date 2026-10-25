import type { Database } from "dofek/db";
import { syncLog } from "dofek/db/schema/events";
import {
  type ProviderAuthFailureReason,
  providerAuthFailureReasonSchema,
} from "dofek/providers/auth-errors";
import { desc, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { buildPostgresFilterConditionsMapped } from "../lib/field-filters.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Zod row schemas
// ---------------------------------------------------------------------------

const tokenRowSchema = z.object({
  provider_id: z.string(),
  updated_at: z.coerce.date(),
  has_tokens: z.boolean(),
});

const lastSyncRowSchema = z.object({
  provider_id: z.string(),
  last_synced: timestampStringSchema,
});

const latestErrorRowSchema = z.object({
  provider_id: z.string(),
  error_message: z.string().nullable(),
  auth_failure_reason: providerAuthFailureReasonSchema.nullable(),
  synced_at: z.coerce.date(),
});

const recentSyncLogRowSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  status: z.string(),
  synced_at: z.coerce.date(),
  duration_ms: z.coerce.number().nullable(),
  record_count: z.coerce.number().nullable(),
  data_type: z.string(),
  error_message: z.string().nullable(),
  auth_failure_reason: z.string().nullable(),
});

const scheduledSyncHealthRowSchema = z.object({
  provider_id: z.string(),
  last_success: timestampStringSchema.nullable(),
  last_attempt: timestampStringSchema,
  last_error: z.string().nullable(),
  consecutive_failures: z.coerce.number().int().nonnegative(),
});

const pushUpdateFilterOptionRowSchema = z.object({
  field: z.string(),
  values: z.array(z.string()),
});
const PUSH_UPDATE_FILTER_FIELDS = {
  id: "id",
  syncedAt: "synced_at",
  dataType: "data_type",
  status: "status",
  recordCount: "record_count",
  errorMessage: "error_message",
  authFailureReason: "auth_failure_reason",
  durationMs: "duration_ms",
} as const;

function recentLog(row: z.infer<typeof recentSyncLogRowSchema>): ProviderRecentSyncLog {
  return {
    id: row.id,
    providerId: row.provider_id,
    status: row.status,
    syncedAt: row.synced_at.toISOString(),
    durationMs: row.duration_ms,
    recordCount: row.record_count,
    dataType: row.data_type,
    errorMessage: row.error_message,
    authFailureReason: row.auth_failure_reason,
  };
}

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
  clinical_records: z.coerce.number(),
});

const climbingLogCountSchema = z.object({
  provider_id: z.string(),
  count: z.coerce.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ProviderConnection {
  providerId: string;
  updatedAt: Date;
  hasTokens: boolean;
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
  clinicalRecords: number;
  climbingLogEntries: number;
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

export interface ProviderRecentSyncLog {
  id: string;
  providerId: string;
  status: string;
  syncedAt: string;
  durationMs: number | null;
  recordCount: number | null;
  dataType: string;
  errorMessage: string | null;
  authFailureReason: string | null;
}

export interface ProviderScheduledSyncHealth {
  providerId: string;
  lastSuccess: string | null;
  lastAttempt: string;
  lastError: string | null;
  consecutiveFailures: number;
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

  /** Get provider connections for this user and whether each has stored sync credentials. */
  async getConnectedProviderIds(): Promise<ProviderConnection[]> {
    const rows = await executeWithSchema(
      this.#db,
      tokenRowSchema,
      sql`SELECT pc.provider_id,
                 COALESCE(ot.updated_at, pc.created_at) AS updated_at,
                 ot.provider_id IS NOT NULL AS has_tokens
          FROM fitness.provider_connection pc
          LEFT JOIN fitness.oauth_token ot
            ON ot.user_id = pc.user_id
            AND ot.provider_id = pc.provider_id
          WHERE pc.user_id = ${this.#userId}`,
    );
    return rows.map((row) => ({
      providerId: row.provider_id,
      updatedAt: row.updated_at,
      hasTokens: row.has_tokens,
    }));
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

  /** Get the most recent successful sync timestamp per provider. */
  async getLastSuccessfulSyncTimes(): Promise<LastSync[]> {
    const rows = await executeWithSchema(
      this.#db,
      lastSyncRowSchema,
      sql`SELECT provider_id, MAX(synced_at) AS last_synced
          FROM fitness.sync_log
          WHERE user_id = ${this.#userId}
            AND status = 'success'
            AND origin = 'scheduled'
          GROUP BY provider_id`,
    );
    return rows.map((row) => ({
      providerId: row.provider_id,
      lastSynced: row.last_synced,
    }));
  }

  /** Current terminal ingest outcomes; lifecycle/no-output successes are not data updates. */
  #pushUpdatesQuery(): SQL {
    return sql`
      SELECT operation.id, operation.provider_id,
             CASE ingest.status WHEN 'succeeded' THEN 'success' ELSE 'error' END AS status,
             ingest.occurred_at AS synced_at,
             NULL::integer AS duration_ms, NULL::integer AS record_count,
             'update'::text AS data_type, ingest.error_message,
             CASE WHEN ingest.error_code = 'provider_auth_failed'
                  THEN 'authorization_failed'::text ELSE NULL::text END AS auth_failure_reason
      FROM fitness.processing_operation operation
      CROSS JOIN LATERAL (
        SELECT status, occurred_at, error_message, error_code
        FROM fitness.processing_stage_event
        WHERE operation_id = operation.id AND stage = 'ingest'
        ORDER BY sequence DESC
        LIMIT 1
      ) ingest
      WHERE operation.user_id = ${this.#userId}::uuid
        AND operation.kind = 'push_ingest'
        AND (ingest.status = 'failed' OR (
          ingest.status = 'succeeded' AND EXISTS (
            SELECT 1 FROM fitness.processing_operation_output output
            WHERE output.operation_id = operation.id
          )
        ))
    `;
  }

  /** Successful push ingestion with emitted data, independent of dashboard readiness. */
  async getLastProcessedUpdateTimes(): Promise<LastSync[]> {
    const rows = await executeWithSchema(
      this.#db,
      lastSyncRowSchema,
      sql`
      SELECT provider_id, MAX(synced_at) AS last_synced
      FROM (${this.#pushUpdatesQuery()}) updates
      WHERE status = 'success'
      GROUP BY provider_id
      ORDER BY provider_id
    `,
    );
    return rows.map((row) => ({ providerId: row.provider_id, lastSynced: row.last_synced }));
  }

  async getRecentPushUpdatesByProvider(
    limitPerProvider: number,
  ): Promise<Map<string, ProviderRecentSyncLog[]>> {
    const rows = await executeWithSchema(
      this.#db,
      recentSyncLogRowSchema,
      sql`
      SELECT recent.* FROM fitness.provider provider
      CROSS JOIN LATERAL (
        SELECT * FROM (${this.#pushUpdatesQuery()}) updates
        WHERE updates.provider_id = provider.id
        ORDER BY synced_at DESC, id DESC
        LIMIT ${limitPerProvider}
      ) recent
      ORDER BY provider_id, synced_at DESC, id DESC
    `,
    );
    const histories = new Map<string, ProviderRecentSyncLog[]>();
    for (const row of rows) {
      const logs = histories.get(row.provider_id) ?? [];
      logs.push(recentLog(row));
      histories.set(row.provider_id, logs);
    }
    return histories;
  }

  async getPushUpdateHistory(
    providerId: string,
    limit: number,
    offset = 0,
    filters: Record<string, string> = {},
  ): Promise<ProviderRecentSyncLog[]> {
    const conditions = [
      sql`provider_id = ${providerId}`,
      ...buildPostgresFilterConditionsMapped(filters, PUSH_UPDATE_FILTER_FIELDS),
    ];
    const rows = await executeWithSchema(
      this.#db,
      recentSyncLogRowSchema,
      sql`
      SELECT * FROM (${this.#pushUpdatesQuery()}) updates
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY synced_at DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}
    `,
    );
    return rows.map(recentLog);
  }

  async getPushUpdateFilterOptions(
    providerId: string,
  ): Promise<Record<string, Array<{ value: string }>>> {
    const rows = await executeWithSchema(
      this.#db,
      pushUpdateFilterOptionRowSchema,
      sql`
      SELECT options.field, array_agg(DISTINCT options.value ORDER BY options.value) AS values
      FROM (${this.#pushUpdatesQuery()}) updates
      CROSS JOIN LATERAL (VALUES
        ('status', updates.status), ('dataType', updates.data_type),
        ('authFailureReason', updates.auth_failure_reason)
      ) options(field, value)
      WHERE updates.provider_id = ${providerId}
        AND options.value IS NOT NULL
      GROUP BY options.field
    `,
    );
    const options: Record<string, Array<{ value: string }>> = {
      status: [],
      dataType: [],
      authFailureReason: [],
    };
    for (const row of rows) options[row.field] = row.values.map((value) => ({ value }));
    return options;
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

  /** Fetch a bounded history for every provider without one provider crowding out another. */
  async getRecentLogsByProvider(
    limitPerProvider: number,
  ): Promise<Map<string, ProviderRecentSyncLog[]>> {
    const rows = await executeWithSchema(
      this.#db,
      recentSyncLogRowSchema,
      sql`SELECT recent.*
          FROM fitness.provider provider
          CROSS JOIN LATERAL (
            SELECT id, provider_id, status, synced_at, duration_ms, record_count,
                   data_type, error_message, auth_failure_reason
            FROM fitness.sync_log
            WHERE user_id = ${this.#userId}
              AND provider_id = provider.id
            ORDER BY synced_at DESC, id DESC
            LIMIT ${limitPerProvider}
          ) recent
          ORDER BY recent.provider_id, recent.synced_at DESC, recent.id DESC`,
    );

    const logsByProvider = new Map<string, ProviderRecentSyncLog[]>();
    for (const row of rows) {
      const logs = logsByProvider.get(row.provider_id) ?? [];
      logs.push({
        id: row.id,
        providerId: row.provider_id,
        status: row.status,
        syncedAt: row.synced_at.toISOString(),
        durationMs: row.duration_ms,
        recordCount: row.record_count,
        dataType: row.data_type,
        errorMessage: row.error_message,
        authFailureReason: row.auth_failure_reason,
      });
      logsByProvider.set(row.provider_id, logs);
    }
    return logsByProvider;
  }

  /** Exact health of top-level scheduled attempts, excluding provider sub-step logs. */
  async getScheduledSyncHealth(): Promise<ProviderScheduledSyncHealth[]> {
    const rows = await executeWithSchema(
      this.#db,
      scheduledSyncHealthRowSchema,
      sql`WITH ordered_attempts AS (
            SELECT
              id,
              provider_id,
              status,
              synced_at,
              error_message,
              ROW_NUMBER() OVER (
                PARTITION BY provider_id
                ORDER BY synced_at DESC, id DESC
              ) AS attempt_number
            FROM fitness.sync_log
            WHERE user_id = ${this.#userId}
              AND data_type = 'sync'
              AND origin = 'scheduled'
          ),
          attempts AS (
            SELECT
              *,
              MAX(synced_at) FILTER (WHERE status = 'success') OVER (
                PARTITION BY provider_id
              ) AS last_success,
              MIN(attempt_number) FILTER (WHERE status = 'success') OVER (
                PARTITION BY provider_id
              ) AS latest_success_attempt_number
            FROM ordered_attempts
          )
          SELECT
            provider_id,
            MAX(last_success) AS last_success,
            MAX(synced_at) AS last_attempt,
            MAX(error_message) FILTER (
              WHERE attempt_number = 1 AND status = 'error'
            ) AS last_error,
            COUNT(*) FILTER (
              WHERE status = 'error'
                AND attempt_number < COALESCE(latest_success_attempt_number, 2147483647)
            )::int AS consecutive_failures
          FROM attempts
          GROUP BY provider_id
          ORDER BY provider_id`,
    );

    return rows.map((row) => ({
      providerId: row.provider_id,
      lastSuccess: row.last_success,
      lastAttempt: row.last_attempt,
      lastError: row.last_error,
      consecutiveFailures: row.consecutive_failures,
    }));
  }

  /** Per-provider record counts broken down by table. */
  async getProviderStats(): Promise<ProviderStatRow[]> {
    const rows = await this.#getClickHouseProviderStats();
    const logRows = await executeWithSchema(
      this.#db,
      climbingLogCountSchema,
      sql`SELECT provider_id, COUNT(*)::int AS count FROM fitness.climbing_log_entry
        WHERE user_id = ${this.#userId}::uuid GROUP BY provider_id ORDER BY provider_id`,
    );
    const logCounts = new Map(logRows.map((row) => [row.provider_id, row.count]));
    const combined = [...rows];
    for (const providerId of logCounts.keys()) {
      if (!rows.some((row) => row.provider_id === providerId))
        combined.push({
          provider_id: providerId,
          activities: 0,
          daily_metrics: 0,
          sleep_sessions: 0,
          body_measurements: 0,
          food_entries: 0,
          health_events: 0,
          metric_stream: 0,
          nutrition_daily: 0,
          clinical_records: 0,
        });
    }
    return combined.map((row) => ({
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
        row.clinical_records +
        (logCounts.get(row.provider_id) ?? 0),
      activities: row.activities,
      dailyMetrics: row.daily_metrics,
      sleepSessions: row.sleep_sessions,
      bodyMeasurements: row.body_measurements,
      foodEntries: row.food_entries,
      healthEvents: row.health_events,
      metricStream: row.metric_stream,
      nutritionDaily: row.nutrition_daily,
      clinicalRecords: row.clinical_records,
      climbingLogEntries: logCounts.get(row.provider_id) ?? 0,
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
          clinical_records
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
