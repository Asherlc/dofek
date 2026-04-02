import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

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
      return { table: "fitness.body_measurement", orderColumn: "recorded_at", idColumn: "id" };
    case "foodEntries":
      return { table: "fitness.food_entry", orderColumn: "date", idColumn: "id" };
    case "healthEvents":
      return { table: "fitness.health_event", orderColumn: "start_date", idColumn: "id" };
    case "metricStream":
      return {
        table: "fitness.sensor_sample",
        orderColumn: "recorded_at",
        idColumn: "recorded_at",
      };
    case "nutritionDaily":
      return { table: "fitness.nutrition_daily", orderColumn: "date", idColumn: "date" };
    case "labPanels":
      return { table: "fitness.lab_panel", orderColumn: "recorded_at", idColumn: "id" };
    case "labResults":
      return { table: "fitness.lab_result", orderColumn: "recorded_at", idColumn: "id" };
    case "journalEntries":
      return { table: "fitness.journal_entry", orderColumn: "date", idColumn: "id" };
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tables to cascade-delete when disconnecting a provider, in deletion order. */
export const DISCONNECT_CHILD_TABLES = [
  "fitness.sensor_sample",
  "fitness.metric_stream",
  "fitness.strength_workout",
  "fitness.body_measurement",
  "fitness.daily_metrics",
  "fitness.sleep_session",
  "fitness.nutrition_daily",
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

  constructor(db: Pick<Database, "execute" | "transaction">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Paginated records for a provider by data type. */
  async getRecords(
    providerId: string,
    dataType: DataType,
    limit: number,
    offset: number,
  ): Promise<Record<string, unknown>[]> {
    const info = tableInfo(dataType);

    const query = sql`SELECT * FROM ${sql.raw(info.table)}
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

    const query = sql`SELECT * FROM ${sql.raw(info.table)}
              WHERE user_id = ${this.#userId}
                AND provider_id = ${providerId}
                AND ${sql.raw(info.idColumn)} = ${recordId}
              LIMIT 1`;

    const rows = await executeWithSchema(this.#db, genericRowSchema, query);
    return rows[0] ?? null;
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
