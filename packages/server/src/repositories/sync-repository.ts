import type { Database } from "dofek/db";
import { syncLog } from "dofek/db/schema/events";
import {
  type ProviderAuthFailureReason,
  providerAuthFailureReasonSchema,
} from "dofek/providers/auth-errors";
import { desc, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

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

const dataHealthRawFreshnessRowSchema = z.object({
  rawRows: z.coerce.number(),
  latestRawAt: timestampStringSchema.nullable(),
});

const dataHealthReadModelFreshnessRowSchema = z.object({
  latestReadModelAt: timestampStringSchema.nullable(),
});

export const dataHealthDatasets = [
  {
    key: "dailyMetrics",
    label: "Daily metrics",
    rawTable: "fitness.daily_metrics",
    rawLatestExpression: "max(date::timestamptz)",
    rawAccessColumn: "date",
    rawAccessKind: "date",
    predicate: sql`AND (hrv IS NOT NULL OR respiratory_rate_avg IS NOT NULL)`,
    readModelTable: "analytics.daily_recovery",
    readModelLatestExpression: "maxOrNull(date)",
    readModelAccessExpression: "date",
    readModelPredicate: "AND (hrv IS NOT NULL OR respiratory_rate IS NOT NULL)",
    freshnessComparisonGrain: "date",
  },
  {
    key: "sleep",
    label: "Sleep",
    rawTable: "fitness.sleep_session",
    rawLatestExpression: "max((started_at - INTERVAL '6 hours')::date::timestamptz)",
    rawAccessColumn: "(started_at - INTERVAL '6 hours')::date",
    rawAccessKind: "date",
    predicate: sql`AND is_nap = false`,
    readModelTable: "analytics.daily_sleep",
    readModelLatestExpression: "maxOrNull(date)",
    readModelAccessExpression: "date",
    readModelPredicate: "",
    freshnessComparisonGrain: "date",
  },
  {
    key: "activity",
    label: "Activities",
    rawTable: "fitness.activity",
    rawLatestExpression: "max(started_at)",
    rawAccessColumn: "started_at",
    rawAccessKind: "local-date",
    predicate: sql`AND provider_absent_at IS NULL AND deleted_at IS NULL`,
    readModelTable: "analytics.activity_summary_rows",
    readModelLatestExpression: "maxOrNull(started_at)",
    readModelAccessExpression: "toDate(toTimeZone(started_at, {timezone:String}))",
    readModelPredicate: "AND is_deleted = 0",
    freshnessComparisonGrain: "timestamp",
  },
] as const;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ProviderToken {
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

export interface DataHealthSensorStore {
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
    options?: { priority?: "dashboard" },
  ): Promise<z.infer<TSchema>[]>;
}

interface DataHealthDatasetQuery {
  key: (typeof dataHealthDatasets)[number]["key"];
  label: string;
  rawTable: string;
  rawLatestExpression: string;
  rawAccessColumn: string;
  rawAccessKind: "date" | "local-date" | "timestamp";
  predicate: SQL;
  readModelTable: string;
  readModelLatestExpression: string;
  readModelAccessExpression: string;
  readModelPredicate: string;
  freshnessComparisonGrain: "date" | "timestamp";
}

export interface DataHealthFreshnessRow {
  key: (typeof dataHealthDatasets)[number]["key"];
  rawRows: number;
  latestRawAt: string | null;
  latestReadModelAt: string | null;
}

function rawAccessWindowPredicate(
  dataset: DataHealthDatasetQuery,
  accessWindow: AccessWindow | undefined,
  timezone: string,
): SQL {
  if (!accessWindow || accessWindow.kind === "full") return sql``;
  const accessColumn = sql.raw(dataset.rawAccessColumn);
  if (dataset.rawAccessKind === "date") {
    return sql`AND ${accessColumn} >= ${accessWindow.startDate}::date
               AND ${accessColumn} < ${accessWindow.endDateExclusive}::date`;
  }
  if (dataset.rawAccessKind === "local-date") {
    return sql`AND (${accessColumn} AT TIME ZONE ${timezone})::date >= ${accessWindow.startDate}::date
               AND (${accessColumn} AT TIME ZONE ${timezone})::date < ${accessWindow.endDateExclusive}::date`;
  }
  return sql`AND ${accessColumn} >= ${accessWindow.startDate}::timestamptz
             AND ${accessColumn} < ${accessWindow.endDateExclusive}::timestamptz`;
}

function readModelAccessWindowClause(
  dataset: DataHealthDatasetQuery,
  accessWindow: AccessWindow | undefined,
): string {
  if (!accessWindow || accessWindow.kind === "full") return "";
  return `AND ${dataset.readModelAccessExpression} >= toDate({accessStartDate:String})
          AND ${dataset.readModelAccessExpression} < toDate({accessEndDateExclusive:String})`;
}

function readModelAccessWindowParams(
  dataset: DataHealthDatasetQuery,
  accessWindow: AccessWindow | undefined,
  timezone: string,
): Record<string, unknown> {
  const timezoneParam = dataset.readModelAccessExpression.includes("{timezone:String}")
    ? { timezone }
    : {};
  if (!accessWindow || accessWindow.kind === "full") return timezoneParam;
  return {
    accessStartDate: accessWindow.startDate,
    accessEndDateExclusive: accessWindow.endDateExclusive,
    ...timezoneParam,
  };
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
      sql`SELECT DISTINCT ot.provider_id, ot.updated_at
          FROM fitness.oauth_token ot
          WHERE ot.user_id = ${this.#userId}`,
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

  /** Freshness details for primary dashboard datasets. */
  async getDataHealthFreshness(
    datasets: readonly DataHealthDatasetQuery[] = dataHealthDatasets,
    sensorStore?: DataHealthSensorStore,
    accessWindow?: AccessWindow,
    timezone = "UTC",
  ): Promise<DataHealthFreshnessRow[]> {
    const [rawFreshnessRows, readModelFreshnessRows] = await Promise.all([
      Promise.all(
        datasets.map((dataset) =>
          executeWithSchema(
            this.#db,
            dataHealthRawFreshnessRowSchema,
            sql`SELECT count(*)::int AS "rawRows",
                       ${sql.raw(dataset.rawLatestExpression)} AS "latestRawAt"
                FROM ${sql.raw(dataset.rawTable)}
                WHERE user_id = ${this.#userId}
                ${rawAccessWindowPredicate(dataset, accessWindow, timezone)}
                ${dataset.predicate}`,
          ),
        ),
      ),
      Promise.all(
        datasets.map((dataset) => {
          if (!sensorStore) return Promise.resolve([]);
          return sensorStore.query(
            dataHealthReadModelFreshnessRowSchema,
            `SELECT ${dataset.readModelLatestExpression} AS latestReadModelAt
             FROM ${dataset.readModelTable} FINAL
             WHERE user_id = {userId:UUID}
             ${readModelAccessWindowClause(dataset, accessWindow)}
             ${dataset.readModelPredicate}`,
            {
              userId: this.#userId,
              ...readModelAccessWindowParams(dataset, accessWindow, timezone),
            },
            { priority: "dashboard" },
          );
        }),
      ),
    ]);

    return datasets.map((dataset, index) => {
      const rawRow = rawFreshnessRows[index]?.[0];
      const readModelRow = readModelFreshnessRows[index]?.[0];
      return {
        key: dataset.key,
        rawRows: rawRow?.rawRows ?? 0,
        latestRawAt: rawRow?.latestRawAt ?? null,
        latestReadModelAt: readModelRow?.latestReadModelAt ?? null,
      };
    });
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
