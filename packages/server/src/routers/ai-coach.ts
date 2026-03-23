import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  type CoachContext,
  type CoachMessage,
  chatWithCoach,
  generateDailyOutlook,
} from "../lib/ai-coach.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

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

/** Fetch current user context for the AI coach */
async function fetchCoachContext(
  db: Parameters<typeof executeWithSchema>[0],
  userId: string,
): Promise<CoachContext> {
  const metricsRows = await executeWithSchema(
    db,
    metricsRowSchema,
    sql`SELECT
          (SELECT duration_minutes / 60.0
           FROM fitness.v_sleep
           WHERE user_id = ${userId} AND is_nap = false
           ORDER BY started_at DESC LIMIT 1) AS sleep_hours,
          (SELECT resting_hr FROM fitness.v_daily_metrics
           WHERE user_id = ${userId} AND resting_hr IS NOT NULL
           ORDER BY date DESC LIMIT 1) AS resting_hr,
          (SELECT hrv FROM fitness.v_daily_metrics
           WHERE user_id = ${userId} AND hrv IS NOT NULL
           ORDER BY date DESC LIMIT 1) AS hrv,
          NULL::real AS readiness`,
  );

  const activityRows = await executeWithSchema(
    db,
    activityRowSchema,
    sql`SELECT
          COALESCE(a.name, a.activity_type) AS name,
          EXTRACT(EPOCH FROM (a.ended_at - a.started_at)) / 60 AS duration_min
        FROM fitness.v_activity a
        WHERE a.user_id = ${userId}
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
      .filter((a) => a.name && a.duration_min)
      .map((a) => `${a.name} ${Math.round(Number(a.duration_min))}min`),
  };
}

export const aiCoachRouter = router({
  /**
   * Daily Outlook — AI-generated personalized daily summary and recommendations
   * based on recent sleep, vitals, and activity data.
   */
  dailyOutlook: cachedProtectedQuery(CacheTTL.LONG).query(async ({ ctx }) => {
    const context = await fetchCoachContext(ctx.db, ctx.userId);
    const result = await generateDailyOutlook(context);

    return {
      summary: result.outlook.summary,
      recommendations: result.outlook.recommendations,
      focusArea: result.outlook.focusArea,
    };
  }),

  /**
   * Chat with the AI coach — send messages and get personalized responses
   * based on user's current health data.
   */
  chat: protectedProcedure
    .input(
      z.object({
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.string().min(1),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const context = await fetchCoachContext(ctx.db, ctx.userId);
      const coachMessages: CoachMessage[] = input.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const result = await chatWithCoach(coachMessages, context);

      return {
        response: result.response,
      };
    }),
});
