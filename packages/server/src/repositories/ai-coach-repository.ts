import type { CoachContext } from "../lib/ai-coach.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const metricsRowSchema = z.object({
  sleep_hours: z.coerce.number().nullable(),
  resting_hr: z.coerce.number().nullable(),
  hrv: z.coerce.number().nullable(),
  readiness: z.coerce.number().nullable(),
});

const activityRowSchema = z.object({
  name: z.string().nullable(),
  duration_min: z.coerce.number().nullable(),
});

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class AiCoachRepository {
  constructor(
    private readonly db: Pick<Database, "execute">,
    private readonly userId: string,
  ) {}

  async fetchContext(): Promise<CoachContext> {
    const metricsRows = await executeWithSchema(
      this.db,
      metricsRowSchema,
      sql`SELECT
            (SELECT duration_minutes / 60.0
             FROM fitness.v_sleep
             WHERE user_id = ${this.userId} AND is_nap = false
             ORDER BY started_at DESC LIMIT 1) AS sleep_hours,
            (SELECT resting_hr FROM fitness.v_daily_metrics
             WHERE user_id = ${this.userId} AND resting_hr IS NOT NULL
             ORDER BY date DESC LIMIT 1) AS resting_hr,
            (SELECT hrv FROM fitness.v_daily_metrics
             WHERE user_id = ${this.userId} AND hrv IS NOT NULL
             ORDER BY date DESC LIMIT 1) AS hrv,
            NULL::real AS readiness`,
    );

    const activityRows = await executeWithSchema(
      this.db,
      activityRowSchema,
      sql`SELECT
            COALESCE(a.name, a.activity_type) AS name,
            EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60 AS duration_min
          FROM fitness.v_activity a
          WHERE a.user_id = ${this.userId}
            AND a.started_at > NOW() - INTERVAL '7 days'
          ORDER BY a.started_at DESC
          LIMIT 5`,
    );

    const metrics = metricsRows[0];

    return {
      sleepHours:
        metrics?.sleep_hours != null ? Math.round(Number(metrics.sleep_hours) * 10) / 10 : undefined,
      restingHr: metrics?.resting_hr != null ? Math.round(Number(metrics.resting_hr)) : undefined,
      hrv: metrics?.hrv != null ? Math.round(Number(metrics.hrv)) : undefined,
      readiness: metrics?.readiness != null ? Math.round(Number(metrics.readiness)) : undefined,
      recentActivities: activityRows
        .filter((activity) => activity.name && activity.duration_min)
        .map((activity) => `${activity.name} ${Math.round(Number(activity.duration_min))}min`),
    };
  }
}
