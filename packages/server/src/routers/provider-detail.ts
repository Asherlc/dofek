import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const REDACTED_ERROR_MESSAGE = "Details hidden";

function redactLogErrorMessage(errorMessage: string | null): string | null {
  if (!errorMessage) return null;
  return REDACTED_ERROR_MESSAGE;
}

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
        table: "fitness.metric_stream",
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

/** Tables to cascade-delete when disconnecting a provider, in deletion order. */
export const DISCONNECT_CHILD_TABLES = [
  "fitness.metric_stream",
  "fitness.exercise_alias",
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

export const providerDetailRouter = router({
  /** Paginated sync logs for a specific provider */
  logs: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        providerId: z.string(),
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { syncLog } = await import("dofek/db/schema");
      const { and, desc, eq } = await import("drizzle-orm");

      const rows = await ctx.db
        .select()
        .from(syncLog)
        .where(and(eq(syncLog.userId, ctx.userId), eq(syncLog.providerId, input.providerId)))
        .orderBy(desc(syncLog.syncedAt))
        .limit(input.limit)
        .offset(input.offset);

      return rows.map((row) => ({
        ...row,
        errorMessage: redactLogErrorMessage(row.errorMessage),
      }));
    }),

  /** Paginated records for a provider by data type */
  records: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        providerId: z.string(),
        dataType: dataTypeEnum,
        limit: z.number().min(1).max(100).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const info = tableInfo(input.dataType);

      // Table/column names come from our own enum mapping (safe for sql.raw),
      // while user inputs are parameterized via the sql template tag.
      const rowSchema = z.record(z.string(), z.unknown());

      const query = sql`SELECT * FROM ${sql.raw(info.table)}
                WHERE user_id = ${ctx.userId}
                  AND provider_id = ${input.providerId}
                ORDER BY ${sql.raw(info.orderColumn)} DESC
                LIMIT ${input.limit}
                OFFSET ${input.offset}`;

      const rows = await executeWithSchema(ctx.db, rowSchema, query);
      return { rows };
    }),

  /** Single record detail with raw data */
  recordDetail: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        providerId: z.string(),
        dataType: dataTypeEnum,
        recordId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const info = tableInfo(input.dataType);

      const rowSchema = z.record(z.string(), z.unknown());

      const query = sql`SELECT * FROM ${sql.raw(info.table)}
                WHERE user_id = ${ctx.userId}
                  AND provider_id = ${input.providerId}
                  AND ${sql.raw(info.idColumn)} = ${input.recordId}
                LIMIT 1`;

      const rows = await executeWithSchema(ctx.db, rowSchema, query);
      return rows[0] ?? null;
    }),

  /** Disconnect a provider — removes all data, OAuth tokens, and provider row */
  disconnect: protectedProcedure
    .input(z.object({ providerId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify ownership first
      const ownerCheck = await executeWithSchema(
        ctx.db,
        z.object({ id: z.string() }),
        sql`SELECT id FROM fitness.provider
            WHERE id = ${input.providerId} AND user_id = ${ctx.userId}`,
      );
      if (ownerCheck.length === 0) {
        throw new Error("Provider not found or not owned by user");
      }

      // Delete all child table rows referencing this provider, then the provider itself.
      // Order matters: lab_result references lab_panel, so lab_result is deleted first.
      const childTables = DISCONNECT_CHILD_TABLES;

      await ctx.db.transaction(async (tx) => {
        for (const table of childTables) {
          await tx.execute(
            sql`DELETE FROM ${sql.raw(table)} WHERE provider_id = ${input.providerId}`,
          );
        }
        await tx.execute(
          sql`DELETE FROM fitness.provider
              WHERE id = ${input.providerId} AND user_id = ${ctx.userId}`,
        );
      });

      return { success: true };
    }),
});
