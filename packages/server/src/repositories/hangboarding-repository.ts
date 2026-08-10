import type { Database } from "dofek/db";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

export interface HangboardingIntervalDetail {
  id: string;
  intervalIndex: number;
  label: string | null;
  intervalType: "work" | "rest" | null;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
}

export interface HangboardingDetail {
  planName: string | null;
  sessionId: string | null;
  boardId: string | null;
  boardName: string | null;
  segmentsError: string | null;
  intervals: HangboardingIntervalDetail[];
}

export interface HangboardingSummary {
  sessionCount: number;
  totalDurationSeconds: number;
  averageDurationSeconds: number | null;
  totalWorkDurationSeconds: number | null;
  totalRestDurationSeconds: number | null;
  workIntervalCount: number | null;
  averageHeartRate: number | null;
  peakHeartRate: number | null;
  latestSession: {
    activityId: string;
    startedAt: string;
    planName: string | null;
    boardName: string | null;
    durationSeconds: number;
  } | null;
  daily: Array<{
    date: string;
    sessionCount: number;
    durationSeconds: number;
    workDurationSeconds: number | null;
    restDurationSeconds: number | null;
  }>;
}

const detailRowSchema = z.object({
  activity_id: z.string(),
  canonical_type: z.string(),
  plan_name: z.string().nullable(),
  session_id: z.string().nullable(),
  board_id: z.string().nullable(),
  board_name: z.string().nullable(),
  segments_error: z.string().nullable(),
  interval_id: z.string().nullable(),
  interval_index: z.coerce.number().int().nullable(),
  label: z.string().nullable(),
  interval_type: z.enum(["work", "rest"]).nullable(),
  interval_started_at: timestampStringSchema.nullable(),
  interval_ended_at: timestampStringSchema.nullable(),
  duration_seconds: z.coerce.number().nullable(),
});

const summaryRowSchema = z.object({
  session_count: z.coerce.number().int().nonnegative(),
  total_duration_seconds: z.coerce.number().nonnegative(),
  average_duration_seconds: z.coerce.number().nullable(),
  total_work_duration_seconds: z.coerce.number().nullable(),
  total_rest_duration_seconds: z.coerce.number().nullable(),
  work_interval_count: z.coerce.number().int().nullable(),
  average_heart_rate: z.coerce.number().nullable(),
  peak_heart_rate: z.coerce.number().nullable(),
  latest_activity_id: z.string().nullable(),
  latest_started_at: timestampStringSchema.nullable(),
  latest_plan_name: z.string().nullable(),
  latest_board_name: z.string().nullable(),
  latest_duration_seconds: z.coerce.number().nullable(),
});

const dailyRowSchema = z.object({
  date: dateStringSchema,
  session_count: z.coerce.number().int().nonnegative(),
  duration_seconds: z.coerce.number().nonnegative(),
  work_duration_seconds: z.coerce.number().nullable(),
  rest_duration_seconds: z.coerce.number().nullable(),
});

const memberSource = sql`
  JOIN LATERAL (
    SELECT member.id AS hang_ten_activity_id, member.started_at, member.ended_at, member.raw
    FROM fitness.activity AS member
    WHERE member.id = ANY(a.member_activity_ids)
      AND member.raw ? 'hangTen'
    ORDER BY (member.id = a.id) DESC, member.created_at DESC
    LIMIT 1
  ) AS member ON TRUE
`;

export class HangboardingRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #accessWindow: AccessWindow;

  constructor(
    database: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    accessWindow?: AccessWindow,
  ) {
    this.#db = database;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#accessWindow = accessWindow ?? { kind: "full", paid: true, reason: "paid_grant" };
  }

  #query<TSchema extends z.ZodType>(schema: TSchema, query: SQL): Promise<z.infer<TSchema>[]> {
    return executeWithSchema(this.#db, schema, query);
  }

  #timestampAccessPredicate(column: SQL): SQL {
    if (this.#accessWindow.kind === "full") return sql``;
    return sql`AND ${column} >= (CAST(${this.#accessWindow.startDate}::date AS timestamp without time zone) AT TIME ZONE ${this.#timezone})
               AND ${column} < (CAST(${this.#accessWindow.endDateExclusive}::date AS timestamp without time zone) AT TIME ZONE ${this.#timezone})`;
  }

  async getDetail(activityId: string): Promise<HangboardingDetail | null> {
    const rows = await this.#query(
      detailRowSchema,
      sql`SELECT
            a.id::text AS activity_id,
            a.canonical_type::text AS canonical_type,
            NULLIF(member.raw->'hangTen'->>'planName', '') AS plan_name,
            NULLIF(member.raw->'hangTen'->>'sessionId', '') AS session_id,
            NULLIF(member.raw->'hangTen'->>'boardId', '') AS board_id,
            NULLIF(member.raw->'hangTen'->>'boardName', '') AS board_name,
            NULLIF(member.raw->'hangTen'->>'activitySegmentsError', '') AS segments_error,
            interval.id::text AS interval_id,
            interval.interval_index,
            interval.label,
            CASE
              WHEN interval.interval_type IN ('work', 'rest') THEN interval.interval_type
              ELSE NULL
            END AS interval_type,
            interval.started_at::text AS interval_started_at,
            interval.ended_at::text AS interval_ended_at,
            CASE
              WHEN interval.ended_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (interval.ended_at - interval.started_at))
              ELSE NULL
            END AS duration_seconds
          FROM fitness.v_activity AS a
          ${memberSource}
          LEFT JOIN fitness.activity_interval AS interval
            ON interval.activity_id = member.hang_ten_activity_id
          WHERE a.user_id = ${this.#userId}::uuid
            AND a.canonical_type = 'hangboard'
            AND ${activityId}::uuid = ANY(a.member_activity_ids)
            ${this.#timestampAccessPredicate(sql`a.started_at`)}
          ORDER BY interval.interval_index NULLS LAST, interval.id`,
    );

    const firstRow = rows[0];
    if (!firstRow || firstRow.canonical_type !== "hangboard") return null;

    return {
      planName: firstRow.plan_name,
      sessionId: firstRow.session_id,
      boardId: firstRow.board_id,
      boardName: firstRow.board_name,
      segmentsError: firstRow.segments_error,
      intervals: [...rows]
        .sort(
          (left, right) =>
            (left.interval_index ?? Number.MAX_SAFE_INTEGER) -
            (right.interval_index ?? Number.MAX_SAFE_INTEGER),
        )
        .flatMap((row) => {
          if (
            row.interval_id === null ||
            row.interval_index === null ||
            row.interval_started_at === null
          ) {
            return [];
          }
          return [
            {
              id: row.interval_id,
              intervalIndex: row.interval_index,
              label: row.label,
              intervalType: row.interval_type,
              startedAt: row.interval_started_at,
              endedAt: row.interval_ended_at,
              durationSeconds: row.duration_seconds,
            },
          ];
        }),
    };
  }

  async getSummary(days: number): Promise<HangboardingSummary> {
    const summaryRows = await this.#query(
      summaryRowSchema,
      sql`WITH sessions AS (
            SELECT
              a.id::text AS activity_id,
              member.hang_ten_activity_id,
              member.started_at,
              member.ended_at,
              NULLIF(member.raw->'hangTen'->>'planName', '') AS plan_name,
              NULLIF(member.raw->'hangTen'->>'boardName', '') AS board_name,
              CASE
                WHEN member.raw->>'avgHeartRate' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (member.raw->>'avgHeartRate')::double precision
                ELSE NULL
              END AS average_heart_rate,
              CASE
                WHEN member.raw->>'maxHeartRate' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (member.raw->>'maxHeartRate')::double precision
                ELSE NULL
              END AS peak_heart_rate
            FROM fitness.v_activity AS a
            ${memberSource}
            WHERE a.user_id = ${this.#userId}::uuid
              AND a.canonical_type = 'hangboard'
              AND a.started_at >= NOW() - make_interval(days => ${days}::int)
              ${this.#timestampAccessPredicate(sql`a.started_at`)}
          ), interval_totals AS (
            SELECT
              sessions.activity_id,
              SUM(EXTRACT(EPOCH FROM (interval.ended_at - interval.started_at)))
                FILTER (WHERE interval.interval_type = 'work' AND interval.ended_at IS NOT NULL)
                AS work_duration_seconds,
              SUM(EXTRACT(EPOCH FROM (interval.ended_at - interval.started_at)))
                FILTER (WHERE interval.interval_type = 'rest' AND interval.ended_at IS NOT NULL)
                AS rest_duration_seconds,
              NULLIF(COUNT(*) FILTER (
                WHERE interval.interval_type = 'work' AND interval.ended_at IS NOT NULL
              ), 0)::int AS work_interval_count
            FROM sessions
            LEFT JOIN fitness.activity_interval AS interval
              ON interval.activity_id = sessions.hang_ten_activity_id
            GROUP BY sessions.activity_id
          ), session_metrics AS (
            SELECT
              sessions.*,
              EXTRACT(EPOCH FROM (sessions.ended_at - sessions.started_at)) AS duration_seconds,
              interval_totals.work_duration_seconds,
              interval_totals.rest_duration_seconds,
              interval_totals.work_interval_count
            FROM sessions
            LEFT JOIN interval_totals ON interval_totals.activity_id = sessions.activity_id
          ), aggregate AS (
            SELECT
              COUNT(*)::int AS session_count,
              COALESCE(SUM(duration_seconds), 0)::double precision AS total_duration_seconds,
              AVG(duration_seconds)::double precision AS average_duration_seconds,
              SUM(work_duration_seconds)::double precision AS total_work_duration_seconds,
              SUM(rest_duration_seconds)::double precision AS total_rest_duration_seconds,
              SUM(work_interval_count)::int AS work_interval_count,
              AVG(average_heart_rate)::double precision AS average_heart_rate,
              MAX(peak_heart_rate)::double precision AS peak_heart_rate
            FROM session_metrics
          ), latest AS (
            SELECT
              activity_id AS latest_activity_id,
              started_at AS latest_started_at,
              plan_name AS latest_plan_name,
              board_name AS latest_board_name,
              COALESCE(duration_seconds, 0)::double precision AS latest_duration_seconds
            FROM session_metrics
            ORDER BY started_at DESC
            LIMIT 1
          )
          SELECT aggregate.*, latest.*
          FROM aggregate
          LEFT JOIN latest ON TRUE`,
    );

    const dailyRows = await this.#query(
      dailyRowSchema,
      sql`WITH sessions AS (
            SELECT
              member.hang_ten_activity_id,
              member.started_at,
              member.ended_at
            FROM fitness.v_activity AS a
            ${memberSource}
            WHERE a.user_id = ${this.#userId}::uuid
              AND a.canonical_type = 'hangboard'
              AND a.started_at >= NOW() - make_interval(days => ${days}::int)
              ${this.#timestampAccessPredicate(sql`a.started_at`)}
          ), session_metrics AS (
            SELECT
              (sessions.started_at AT TIME ZONE ${this.#timezone})::date AS local_date,
              sessions.started_at,
              EXTRACT(EPOCH FROM (sessions.ended_at - sessions.started_at)) AS duration_seconds,
              SUM(EXTRACT(EPOCH FROM (interval.ended_at - interval.started_at)))
                FILTER (WHERE interval.interval_type = 'work' AND interval.ended_at IS NOT NULL)
                AS work_duration_seconds,
              SUM(EXTRACT(EPOCH FROM (interval.ended_at - interval.started_at)))
                FILTER (WHERE interval.interval_type = 'rest' AND interval.ended_at IS NOT NULL)
                AS rest_duration_seconds
            FROM sessions
            LEFT JOIN fitness.activity_interval AS interval
              ON interval.activity_id = sessions.hang_ten_activity_id
            GROUP BY sessions.started_at, sessions.ended_at, sessions.hang_ten_activity_id
          )
          SELECT
            local_date AS date,
            COUNT(*)::int AS session_count,
            COALESCE(SUM(duration_seconds), 0)::double precision AS duration_seconds,
            SUM(work_duration_seconds)::double precision AS work_duration_seconds,
            SUM(rest_duration_seconds)::double precision AS rest_duration_seconds
          FROM session_metrics
          GROUP BY local_date
          ORDER BY date`,
    );

    const summary = summaryRows[0];
    if (!summary) {
      return {
        sessionCount: 0,
        totalDurationSeconds: 0,
        averageDurationSeconds: null,
        totalWorkDurationSeconds: null,
        totalRestDurationSeconds: null,
        workIntervalCount: null,
        averageHeartRate: null,
        peakHeartRate: null,
        latestSession: null,
        daily: dailyRows.map((row) => this.#toDaily(row)),
      };
    }

    return {
      sessionCount: summary.session_count,
      totalDurationSeconds: summary.total_duration_seconds,
      averageDurationSeconds: summary.average_duration_seconds,
      totalWorkDurationSeconds: summary.total_work_duration_seconds,
      totalRestDurationSeconds: summary.total_rest_duration_seconds,
      workIntervalCount: summary.work_interval_count,
      averageHeartRate: summary.average_heart_rate,
      peakHeartRate: summary.peak_heart_rate,
      latestSession:
        summary.latest_activity_id && summary.latest_started_at
          ? {
              activityId: summary.latest_activity_id,
              startedAt: summary.latest_started_at,
              planName: summary.latest_plan_name,
              boardName: summary.latest_board_name,
              durationSeconds: summary.latest_duration_seconds ?? 0,
            }
          : null,
      daily: dailyRows.map((row) => this.#toDaily(row)),
    };
  }

  #toDaily(row: z.infer<typeof dailyRowSchema>) {
    return {
      date: row.date,
      sessionCount: row.session_count,
      durationSeconds: row.duration_seconds,
      workDurationSeconds: row.work_duration_seconds,
      restDurationSeconds: row.rest_duration_seconds,
    };
  }
}
