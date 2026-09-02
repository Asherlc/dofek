import { resolveRecordLocalTimeContext } from "@dofek/format/record-local-time";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, type SchemaExecutionDatabase } from "./typed-sql.ts";

const candidateSchema = z.object({
  id: z.string().uuid(),
  timezone: z.string(),
  local_time_source: z.enum(["unknown", "provider_timezone"]),
  home_timezone: z.string().nullable(),
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
            activity.id::text AS id,
            activity.timezone,
            activity.local_time_source,
            settings.value #>> '{}' AS home_timezone,
            activity.started_at,
            activity.ended_at
          FROM fitness.activity AS activity
          LEFT JOIN fitness.user_settings AS settings
            ON settings.user_id = activity.user_id
           AND settings.key = 'homeTimezone'
          WHERE activity.timezone IS NOT NULL
            AND trim(activity.timezone) <> ''
            AND activity.started_at >= ${options.startAt}
            AND activity.started_at < ${options.endAt}
            AND (
              activity.local_time_source = 'unknown'
              OR (
                activity.local_time_source = 'provider_timezone'
                AND trim(activity.timezone) ~ '^Etc/GMT([+-][0-9]{1,2})?$'
                AND settings.value #>> '{}' IS NOT NULL
              )
            )
            ${cursor == null ? sql`` : sql`AND activity.id > ${cursor}::uuid`}
          ORDER BY activity.id
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
      source: "provider_timezone" | "user_home_timezone";
      priorSource: "unknown" | "provider_timezone";
      priorTimezone: string;
    }> = rows.flatMap((row) => {
      try {
        resolveRecordLocalTimeContext({
          startedAt: row.started_at,
          endedAt: row.ended_at,
          timezone: row.timezone,
          source: "provider_timezone",
        });
        const homeTimezone = row.home_timezone || null;
        const useHomeTimezone = isFixedEtcGmtZone(row.timezone.trim()) && homeTimezone !== null;
        const source = useHomeTimezone ? "user_home_timezone" : "provider_timezone";
        const context = resolveRecordLocalTimeContext({
          startedAt: row.started_at,
          endedAt: row.ended_at,
          timezone: useHomeTimezone ? homeTimezone : row.timezone,
          source,
        });
        return [
          {
            id: row.id,
            ...context,
            source,
            priorSource: row.local_time_source,
            priorTimezone: row.timezone,
          },
        ];
      } catch {
        result.skipped += 1;
        return [];
      }
    });

    if (!options.execute || contexts.length === 0) continue;

    const values = sql.join(
      contexts.map(
        (context) =>
          sql`(${context.id}::uuid, ${context.timezone}::text, ${context.startUtcOffsetMinutes}::bigint, ${context.endUtcOffsetMinutes}::bigint, ${context.source}::text, ${context.priorSource}::text, ${context.priorTimezone}::text)`,
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
            local_time_source,
            prior_local_time_source,
            prior_timezone
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
              AND activity.local_time_source = context_values.prior_local_time_source
              AND activity.timezone IS NOT DISTINCT FROM context_values.prior_timezone
            RETURNING 1
          )
          SELECT count(*)::int AS count
          FROM updated`,
    );
    result.updated += countRows[0]?.count ?? 0;
  }

  return result;
}

function isFixedEtcGmtZone(timezone: string): boolean {
  return /^Etc\/GMT(?:[+-]\d{1,2})?$/.test(timezone);
}
