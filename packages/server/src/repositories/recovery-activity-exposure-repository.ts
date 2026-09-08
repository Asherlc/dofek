import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { postgresActivityLocalDate } from "./activity-local-date.ts";

export interface RecoveryActivityExposureFilters {
  providers: readonly string[];
  modalities: readonly string[];
}

const dailyExposureRowSchema = z.object({
  date: z.string(),
  activity_count: z.coerce.number().int().nonnegative(),
  duration_minutes: z.coerce.number().nonnegative().nullable(),
  supported_duration_count: z.coerce.number().int().nonnegative(),
  missing_end_count: z.coerce.number().int().nonnegative(),
  invalid_interval_count: z.coerce.number().int().nonnegative(),
  canonical_types: z.array(z.string()),
  modalities: z.array(z.string()),
  source_providers: z.array(z.string()),
  source_activity_ids: z.array(z.string()),
  source_activity_ids_truncated: z.boolean(),
  authoritative_date_count: z.coerce.number().int().nonnegative(),
  assumed_date_count: z.coerce.number().int().nonnegative(),
});

export type RecoveryDailyActivityExposure = z.infer<typeof dailyExposureRowSchema>;

/** Compact daily activity exposure over canonical, query-time deduplicated activities. */
export class RecoveryActivityExposureRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async listDailyExposureRange(
    startDate: string,
    endDate: string,
    filters: RecoveryActivityExposureFilters,
  ): Promise<RecoveryDailyActivityExposure[]> {
    const providerPredicate =
      filters.providers.length === 0
        ? sql`true`
        : sql`a.source_providers && ARRAY[${sql.join(
            filters.providers.map((provider) => sql`${provider}`),
            sql`, `,
          )}]::text[]`;
    const modalityPredicate =
      filters.modalities.length === 0
        ? sql`true`
        : sql`a.modality::text IN (${sql.join(
            filters.modalities.map((modality) => sql`${modality}`),
            sql`, `,
          )})`;
    const localDate = postgresActivityLocalDate(sql`a`, this.#timezone);

    return executeWithSchema(
      this.#db,
      dailyExposureRowSchema,
      sql`WITH selected AS (
        SELECT
          a.id,
          a.canonical_type::text AS canonical_type,
          a.modality::text AS modality,
          a.source_providers,
          a.ended_at,
          ${localDate} AS date,
          CASE
            WHEN a.local_time_source <> 'unknown'
              AND a.start_utc_offset_minutes IS NOT NULL THEN true
            ELSE false
          END AS authoritative_date,
          CASE
            WHEN a.ended_at IS NULL OR a.ended_at <= a.started_at THEN NULL
            ELSE EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60.0
          END AS duration_minutes
        FROM fitness.v_activity AS a
        WHERE a.user_id = ${this.#userId}::uuid
          AND ${providerPredicate}
          AND ${modalityPredicate}
      )
      SELECT
        date::text AS date,
        count(*)::int AS activity_count,
        CASE WHEN count(duration_minutes) = count(*)
          THEN sum(duration_minutes)::double precision
          ELSE NULL
        END AS duration_minutes,
        count(duration_minutes)::int AS supported_duration_count,
        count(*) FILTER (WHERE duration_minutes IS NULL AND ended_at IS NULL)::int
          AS missing_end_count,
        count(*) FILTER (WHERE duration_minutes IS NULL AND ended_at IS NOT NULL)::int
          AS invalid_interval_count,
        array_agg(DISTINCT canonical_type ORDER BY canonical_type) AS canonical_types,
        COALESCE(
          array_agg(DISTINCT modality ORDER BY modality) FILTER (WHERE modality IS NOT NULL),
          ARRAY[]::text[]
        ) AS modalities,
        COALESCE(
          (SELECT array_agg(DISTINCT provider ORDER BY provider)
           FROM selected AS source, unnest(source.source_providers) AS provider
           WHERE source.date = selected.date),
          ARRAY[]::text[]
        ) AS source_providers,
        (array_agg(id::text ORDER BY id::text))[1:100] AS source_activity_ids,
        count(*) > 100 AS source_activity_ids_truncated,
        count(*) FILTER (WHERE authoritative_date)::int AS authoritative_date_count,
        count(*) FILTER (WHERE NOT authoritative_date)::int AS assumed_date_count
      FROM selected
      WHERE date BETWEEN ${startDate}::date AND ${endDate}::date
      GROUP BY date
      ORDER BY date`,
    );
  }
}
