import { resolveRecordLocalTimeContext } from "@dofek/format/record-local-time";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const candidateSchema = z.object({
  id: z.string().uuid(),
  timezone: z.string(),
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable(),
});

const countSchema = z.object({ count: z.coerce.number().int().nonnegative() });

export interface RecordLocalTimeBackfillOptions {
  execute: boolean;
  batchSize: number;
  maxBatches: number;
  startAt: Date;
  endAt: Date;
}

export interface RecordLocalTimeBackfillResult {
  eligible: number;
  skipped: number;
  updated: number;
}

export async function backfillRecordLocalTimeContext(
  db: SchemaExecutionDatabase,
  options: RecordLocalTimeBackfillOptions,
): Promise<RecordLocalTimeBackfillResult> {
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 1_000) {
    throw new Error("batchSize must be an integer between 1 and 1000");
  }
  if (!Number.isInteger(options.maxBatches) || options.maxBatches < 1) {
    throw new Error("maxBatches must be a positive integer");
  }
  if (!Number.isFinite(options.startAt.getTime())) {
    throw new Error("startAt must be a valid date");
  }
  if (!Number.isFinite(options.endAt.getTime())) {
    throw new Error("endAt must be a valid date");
  }
  if (options.startAt >= options.endAt) {
    throw new Error("startAt must be earlier than endAt");
  }

  let cursor: string | null = null;
  const result: RecordLocalTimeBackfillResult = { eligible: 0, skipped: 0, updated: 0 };

  for (let batchIndex = 0; batchIndex < options.maxBatches; batchIndex += 1) {
    const rows: z.infer<typeof candidateSchema>[] = await executeWithSchema(
      db,
      candidateSchema,
      sql`SELECT
            id::text AS id,
            timezone,
            started_at,
            ended_at
          FROM fitness.activity
          WHERE local_time_source = 'unknown'
            AND timezone IS NOT NULL
            AND trim(timezone) <> ''
            AND started_at >= ${options.startAt}
            AND started_at < ${options.endAt}
            ${cursor == null ? sql`` : sql`AND id > ${cursor}::uuid`}
          ORDER BY id
          LIMIT ${options.batchSize}`,
    );
    if (rows.length === 0) break;

    result.eligible += rows.length;
    cursor = rows.at(-1)?.id ?? cursor;
    const contexts: Array<{
      id: string;
      timezone: string | null;
      startUtcOffsetMinutes: number | null;
      endUtcOffsetMinutes: number | null;
      source: "provider_timezone";
    }> = rows.flatMap((row) => {
      try {
        const context = resolveRecordLocalTimeContext({
          startedAt: row.started_at,
          endedAt: row.ended_at,
          timezone: row.timezone,
          source: "provider_timezone",
        });
        return [{ id: row.id, ...context, source: "provider_timezone" as const }];
      } catch {
        result.skipped += 1;
        return [];
      }
    });

    if (!options.execute || contexts.length === 0) continue;

    const values = sql.join(
      contexts.map(
        (context) =>
          sql`(${context.id}::uuid, ${context.timezone}::text, ${context.startUtcOffsetMinutes}::bigint, ${context.endUtcOffsetMinutes}::bigint, ${context.source}::text)`,
      ),
      sql`, `,
    );
    const countRows = await executeWithSchema(
      db,
      countSchema,
      sql`WITH context_values (
            id,
            timezone,
            start_utc_offset_minutes,
            end_utc_offset_minutes,
            local_time_source
          ) AS (
            VALUES ${values}
          ),
          updated AS (
            UPDATE fitness.activity AS activity
            SET
              timezone = context_values.timezone,
              start_utc_offset_minutes = context_values.start_utc_offset_minutes,
              end_utc_offset_minutes = context_values.end_utc_offset_minutes,
              local_time_source = context_values.local_time_source
            FROM context_values
            WHERE activity.id = context_values.id
              AND activity.local_time_source = 'unknown'
            RETURNING 1
          )
          SELECT count(*)::int AS count
          FROM updated`,
    );
    result.updated += countRows[0]?.count ?? 0;
  }

  return result;
}
