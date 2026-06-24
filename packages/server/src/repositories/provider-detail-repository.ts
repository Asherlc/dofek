import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";

// ---------------------------------------------------------------------------
// Data type mapping
// ---------------------------------------------------------------------------

export const dataTypeEnum = z.enum([
  "activities",
  "dailyMetrics",
  "sleepSessions",
  "bodyMeasurements",
  "foodEntries",
  "healthEvents",
  "metricStream",
  "nutritionDaily",
  "labPanels",
  "labResults",
  "journalEntries",
]);

type DataType = z.infer<typeof dataTypeEnum>;

/** Map data type enum to SQL table name and ordering column */
export function tableInfo(dataType: DataType): {
  table: string;
  orderColumn: string;
  idColumn: string;
} {
  switch (dataType) {
    case "activities":
      return { table: "fitness.activity", orderColumn: "started_at", idColumn: "id" };
    case "dailyMetrics":
      return { table: "fitness.daily_metrics", orderColumn: "date", idColumn: "date" };
    case "sleepSessions":
      return { table: "fitness.sleep_session", orderColumn: "started_at", idColumn: "id" };
    case "bodyMeasurements":
      return { table: "analytics.v_body_measurement", orderColumn: "recorded_at", idColumn: "id" };
    case "foodEntries":
      return { table: "fitness.food_entry", orderColumn: "date", idColumn: "id" };
    case "healthEvents":
      return { table: "fitness.health_event", orderColumn: "start_date", idColumn: "id" };
    case "metricStream":
      return {
        table: "ingest.metric_stream",
        orderColumn: "recorded_at",
        idColumn: "id",
      };
    case "nutritionDaily":
      return { table: "fitness.v_nutrition_daily", orderColumn: "date", idColumn: "date" };
    case "labPanels":
      return { table: "fitness.lab_panel", orderColumn: "recorded_at", idColumn: "id" };
    case "labResults":
      return { table: "fitness.lab_result", orderColumn: "recorded_at", idColumn: "id" };
    case "journalEntries":
      return { table: "fitness.journal_entry", orderColumn: "date", idColumn: "id" };
  }
}

function listColumns(dataType: Exclude<DataType, "bodyMeasurements" | "metricStream">): string {
  switch (dataType) {
    case "activities":
      return [
        "id",
        "provider_id",
        "external_id",
        "activity_type",
        "started_at",
        "ended_at",
        "name",
        "source_name",
        "provider_absent_at",
        "deleted_at",
        "created_at",
      ].join(", ");
    case "dailyMetrics":
      return [
        "id",
        "provider_id",
        "date",
        "hrv",
        "respiratory_rate_avg",
        "steps",
        "active_energy_kcal",
        "distance_km",
        "source_name",
        "created_at",
      ].join(", ");
    case "sleepSessions":
      return [
        "id",
        "provider_id",
        "external_id",
        "started_at",
        "ended_at",
        "duration_minutes",
        "sleep_type",
        "source_name",
        "created_at",
      ].join(", ");
    case "foodEntries":
      return [
        "id",
        "provider_id",
        "external_id",
        "date",
        "meal",
        "food_name",
        "logged_at",
        "source_name",
        "created_at",
      ].join(", ");
    case "healthEvents":
      return [
        "id",
        "provider_id",
        "external_id",
        "type",
        "value",
        "value_text",
        "unit",
        "source_name",
        "start_date",
        "end_date",
        "created_at",
      ].join(", ");
    case "nutritionDaily":
      return [
        "date",
        "provider_id",
        "calories",
        "protein_g",
        "carbs_g",
        "fat_g",
        "fiber_g",
        "sugar_g",
      ].join(", ");
    case "labPanels":
      return [
        "id",
        "provider_id",
        "external_id",
        "name",
        "loinc_code",
        "status",
        "source_name",
        "recorded_at",
        "issued_at",
        "created_at",
      ].join(", ");
    case "labResults":
      return [
        "id",
        "provider_id",
        "panel_id",
        "external_id",
        "test_name",
        "loinc_code",
        "value",
        "value_text",
        "unit",
        "status",
        "recorded_at",
        "created_at",
      ].join(", ");
    case "journalEntries":
      return [
        "id",
        "provider_id",
        "date",
        "question_slug",
        "answer_text",
        "answer_numeric",
        "impact_score",
        "created_at",
      ].join(", ");
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tables to cascade-delete when disconnecting a provider, in deletion order. */
export const DISCONNECT_CHILD_TABLES = [
  "fitness.daily_metrics",
  "fitness.sleep_session",
  "fitness.food_entry",
  "fitness.lab_result",
  "fitness.lab_panel",
  "fitness.health_event",
  "fitness.journal_entry",
  "fitness.dexa_scan",
  "fitness.sync_log",
  "fitness.activity",
  "fitness.oauth_token",
];

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const ownerCheckSchema = z.object({ id: z.string() });
const genericRowSchema = z.record(z.string(), z.unknown());

function isUndefinedTableError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.includes("does not exist");
  }
  if (typeof error === "object" && error !== null) {
    if ("code" in error && error.code === "42P01") {
      return true;
    }
    if ("message" in error && typeof error.message === "string") {
      return error.message.includes("does not exist");
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for provider detail pages: logs, records, and disconnect. */
export class ProviderDetailRepository {
  readonly #db: Pick<Database, "execute" | "transaction">;
  readonly #userId: string;
  // ClickHouse query runner. Serves the read-models that have moved off
  // Postgres: body measurements (analytics.v_body_measurement) and the
  // Redpanda-fed metric stream (ingest.metric_stream).
  readonly #clickHouse: BodyClickHouseStore | undefined;

  constructor(
    db: Pick<Database, "execute" | "transaction">,
    userId: string,
    clickHouse?: BodyClickHouseStore,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#clickHouse = clickHouse;
  }

  /** Paginated records for a provider by data type. */
  async getRecords(
    providerId: string,
    dataType: DataType,
    limit: number,
    offset: number,
  ): Promise<Record<string, unknown>[]> {
    const info = tableInfo(dataType);

    if (dataType === "bodyMeasurements") {
      return this.#queryBodyRecords(providerId, info, limit, offset);
    }

    if (dataType === "metricStream") {
      return this.#queryMetricStreamRecords(providerId, limit, offset);
    }

    const query = sql`SELECT ${sql.raw(listColumns(dataType))} FROM ${sql.raw(info.table)}
              WHERE user_id = ${this.#userId}
                AND provider_id = ${providerId}
              ORDER BY ${sql.raw(info.orderColumn)} DESC
              LIMIT ${limit}
              OFFSET ${offset}`;

    return executeWithSchema(this.#db, genericRowSchema, query);
  }

  /** Single record detail with raw data. */
  async getRecordDetail(
    providerId: string,
    dataType: DataType,
    recordId: string,
  ): Promise<Record<string, unknown> | null> {
    const info = tableInfo(dataType);

    if (dataType === "bodyMeasurements") {
      const rows = await this.#queryBodyRecords(providerId, info, 1, 0, recordId);
      return rows[0] ?? null;
    }

    if (dataType === "metricStream") {
      const rows = await this.#queryMetricStreamRecords(providerId, 1, 0, recordId);
      return rows[0] ?? null;
    }

    const query = sql`SELECT * FROM ${sql.raw(info.table)}
              WHERE user_id = ${this.#userId}
                AND provider_id = ${providerId}
                AND ${sql.raw(info.idColumn)} = ${recordId}
              LIMIT 1`;

    const rows = await executeWithSchema(this.#db, genericRowSchema, query);
    return rows[0] ?? null;
  }

  async #queryBodyRecords(
    providerId: string,
    info: ReturnType<typeof tableInfo>,
    limit: number,
    offset: number,
    recordId?: string,
  ): Promise<Record<string, unknown>[]> {
    if (!this.#clickHouse) {
      throw new Error("providerDetail body measurements require the ClickHouse store");
    }
    const recordFilter = recordId ? "AND toString(id) = {recordId:String}" : "";
    return this.#clickHouse.query(
      genericRowSchema,
      `
        SELECT *
        FROM ${info.table}
        WHERE user_id = {userId:UUID}
          AND provider_id = {providerId:String}
          ${recordFilter}
        ORDER BY ${info.orderColumn} DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
      `,
      {
        userId: this.#userId,
        providerId,
        ...(recordId ? { recordId } : {}),
        limit,
        offset,
      },
    );
  }

  /**
   * Raw metric-stream rows for a provider, read from the Redpanda-fed ClickHouse
   * mirror (Postgres `fitness.metric_stream` is retired). Version-deduplicated
   * (`FINAL` + `is_deleted = 0`); recorded_at formatted to ISO-8601 Z.
   */
  async #queryMetricStreamRecords(
    providerId: string,
    limit: number,
    offset: number,
    recordId?: string,
  ): Promise<Record<string, unknown>[]> {
    if (!this.#clickHouse) {
      throw new Error("providerDetail metric stream requires the ClickHouse store");
    }
    const recordFilter = recordId ? "AND toString(id) = {recordId:String}" : "";
    return this.#clickHouse.query(
      genericRowSchema,
      `
        SELECT
          id,
          -- Raw record view: preserve sub-second precision (%f = microseconds).
          -- Force UTC so the literal 'Z' suffix is accurate regardless of the
          -- column's or server's timezone.
          formatDateTime(recorded_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS recorded_at,
          provider_id,
          external_id,
          device_id,
          source_type,
          channel,
          activity_id,
          scalar
        FROM ingest.metric_stream FINAL
        WHERE user_id = {userId:UUID}
          AND provider_id = {providerId:String}
          AND is_deleted = 0
          ${recordFilter}
        ORDER BY recorded_at DESC
        LIMIT {limit:UInt32}
        OFFSET {offset:UInt32}
      `,
      {
        userId: this.#userId,
        providerId,
        ...(recordId ? { recordId } : {}),
        limit,
        offset,
      },
    );
  }

  /** Verify provider ownership. Returns true if the provider belongs to the user. */
  async verifyOwnership(providerId: string): Promise<boolean> {
    const rows = await executeWithSchema(
      this.#db,
      ownerCheckSchema,
      sql`SELECT provider_id AS id FROM fitness.oauth_token
          WHERE provider_id = ${providerId} AND user_id = ${this.#userId}
          UNION ALL
          SELECT id FROM fitness.provider
          WHERE id = ${providerId} AND user_id = ${this.#userId}
          UNION ALL
          SELECT provider_id AS id FROM fitness.activity
          WHERE provider_id = ${providerId} AND user_id = ${this.#userId}
          UNION ALL
          SELECT provider_id AS id FROM fitness.daily_metrics
          WHERE provider_id = ${providerId} AND user_id = ${this.#userId}
          UNION ALL
          SELECT provider_id AS id FROM fitness.sleep_session
          WHERE provider_id = ${providerId} AND user_id = ${this.#userId}
          LIMIT 1`,
    );
    return rows.length > 0;
  }

  /**
   * Disconnect a provider — removes all user-scoped child data and tokens.
   * Caller must verify ownership before calling this method.
   */
  async deleteProviderData(providerId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      for (const table of DISCONNECT_CHILD_TABLES) {
        try {
          await tx.execute(
            sql`DELETE FROM ${sql.raw(table)}
                WHERE provider_id = ${providerId} AND user_id = ${this.#userId}`,
          );
        } catch (error: unknown) {
          if (!isUndefinedTableError(error)) {
            throw error;
          }
        }
      }
    });
  }
}
