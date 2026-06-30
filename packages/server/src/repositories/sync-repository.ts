import { PUSH_PROVIDERS } from "@dofek/providers/push-providers";
import type { Database } from "dofek/db";
import {
  type ProviderAuthFailureReason,
  providerAuthFailureReasonSchema,
} from "dofek/providers/auth-errors";
import { sql } from "drizzle-orm";
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

export interface ProviderToken {
  providerId: string;
  updatedAt: Date;
}

export interface LastSync {
  providerId: string;
  lastSynced: string;
}

export interface PushProviderLastReceived {
  providerId: string;
  lastReceived: string;
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
      sql`SELECT DISTINCT ON (provider_id)
            provider_id,
            error_message,
            auth_failure_reason,
            synced_at
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
      authFailureReason: row.auth_failure_reason,
      syncedAt: row.synced_at,
    }));
  }

  /** Get the most recent metric stream sample timestamp for push-only providers. */
  async getPushProviderLastReceived(): Promise<PushProviderLastReceived[]> {
    if (!this.#providerStatsStore || PUSH_PROVIDERS.length === 0) {
      return [];
    }

    const providerIds = PUSH_PROVIDERS.map((provider) => provider.id);
    const lastReceivedRowSchema = z.object({
      provider_id: z.string(),
      last_received: z.string(),
    });

    const rows = await this.#providerStatsStore.query(
      lastReceivedRowSchema,
      // FINAL keeps is_deleted/recorded_at aligned with the latest ReplacingMergeTree row.
      `
        SELECT
          provider_id,
          max(recorded_at) AS last_received
        FROM ingest.metric_stream FINAL
        WHERE user_id = {userId:UUID}
          AND provider_id IN {providerIds:Array(String)}
          AND is_deleted = 0
        GROUP BY provider_id
      `,
      { userId: this.#userId, providerIds },
    );

    return rows.map((row) => ({
      providerId: row.provider_id,
      lastReceived: row.last_received,
    }));
  }

  /** Fetch sync logs ordered by most recent first. */
  async getLogs(limit: number): Promise<SyncLogRow[]> {
    const { syncLog } = await import("dofek/db/schema/events");
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
