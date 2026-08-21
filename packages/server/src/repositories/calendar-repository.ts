import {
  type ActivityHeatmapBandId,
  activityHeatmapBandById,
  activityHeatmapBandForMinutes,
} from "@dofek/training/activity-heatmap";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { ChartRange } from "../lib/chart-range.ts";
import type { RangeDays } from "../lib/date-window.ts";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export interface CalendarDayRow {
  date: string;
  activityCount: number;
  totalMinutes: number;
  activityTypes: string[];
}

/** A single day on the activity calendar with aggregated counts and types. */
export class CalendarDay {
  readonly #row: CalendarDayRow;

  constructor(row: CalendarDayRow) {
    this.#row = row;
  }

  get date(): string {
    return this.#row.date;
  }

  get activityCount(): number {
    return this.#row.activityCount;
  }

  toDetail() {
    const trainingTimeBand: ActivityHeatmapBandId = activityHeatmapBandForMinutes(
      this.#row.totalMinutes,
    );
    return {
      ...this.#row,
      trainingTimeBand,
      trainingTimeMeaning: activityHeatmapBandById(trainingTimeBand).meaning,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const calendarRowSchema = z.object({
  date: dateStringSchema,
  activity_count: z.coerce.number(),
  total_minutes: z.coerce.number(),
  canonical_types: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for the activity calendar heatmap. */
export class CalendarRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;

  constructor(db: Pick<Database, "execute">, userId: string, timezone: string) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  /** Daily activity counts for calendar heatmap rendering. */
  async getCalendarData(days: RangeDays): Promise<CalendarDay[]> {
    const rangeFilter = ChartRange.fromDays(days).postgresTimestampAfterNow(sql`a.started_at`);
    const rows = await executeWithSchema(
      this.#db,
      calendarRowSchema,
      sql`SELECT
          (a.started_at AT TIME ZONE ${this.#timezone})::date as date,
          COUNT(*)::int as activity_count,
          ROUND(SUM(EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60)::numeric) as total_minutes,
          array_agg(DISTINCT a.canonical_type::text) as canonical_types
        FROM fitness.v_activity a
        WHERE a.user_id = ${this.#userId}
          ${rangeFilter}
          AND a.ended_at IS NOT NULL
        GROUP BY 1
        ORDER BY date`,
    );

    return rows.map(
      (row) =>
        new CalendarDay({
          date: row.date,
          activityCount: row.activity_count,
          totalMinutes: row.total_minutes,
          activityTypes: row.canonical_types,
        }),
    );
  }
}
