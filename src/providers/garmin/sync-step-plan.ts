import { and, eq, gte, isNotNull, lt, lte, or } from "drizzle-orm";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../db/clickhouse.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { dailyMetrics, sleepSession } from "../../db/schema/activity.ts";
import { HEART_RATE, STRESS } from "../../db/sensor-channels.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { planSyncStepIfRequestNotPending } from "../../lib/sync-request-query.ts";
import { listPendingSyncRequestQueryKeys } from "../../lib/sync-request-queue.ts";
import { garminSyncStepToApiQuery } from "./sync-api-query.ts";
import type { GarminSyncStep } from "./sync-checkpoint.ts";

export interface GarminSyncPlanContext {
  db: SyncDatabase;
  providerId: string;
  userId?: string;
  sinceDate: string;
  untilDate: string;
  dates: string[];
}

const metricStreamDateRowSchema = z.object({ date: z.string() });

function resolveUserId(context: Pick<GarminSyncPlanContext, "userId">): string | undefined {
  return context.userId ?? getTokenUserId();
}

function dayStartUtc(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function dayAfterUtc(date: string): Date {
  const next = dayStartUtc(date);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

function utcDateString(timestamp: Date): string {
  return timestamp.toISOString().slice(0, 10);
}

export async function listGarminDatesNeedingSleepSteps(
  context: GarminSyncPlanContext,
): Promise<string[]> {
  const userId = resolveUserId(context);
  if (userId == null) return context.dates;

  const rangeStart = dayStartUtc(context.sinceDate);
  const rangeEnd = dayAfterUtc(context.untilDate);

  const sessions = await context.db
    .select({ startedAt: sleepSession.startedAt, endedAt: sleepSession.endedAt })
    .from(sleepSession)
    .where(
      and(
        eq(sleepSession.userId, userId),
        eq(sleepSession.providerId, context.providerId),
        or(
          and(gte(sleepSession.startedAt, rangeStart), lt(sleepSession.startedAt, rangeEnd)),
          and(gte(sleepSession.endedAt, rangeStart), lt(sleepSession.endedAt, rangeEnd)),
        ),
      ),
    );

  const syncedDates = new Set<string>();
  for (const session of sessions) {
    for (const timestamp of [session.startedAt, session.endedAt]) {
      if (timestamp == null) continue;
      const date = utcDateString(timestamp);
      if (date >= context.sinceDate && date <= context.untilDate) {
        syncedDates.add(date);
      }
    }
  }

  return context.dates.filter((date) => !syncedDates.has(date));
}

export async function listGarminDatesNeedingDailySummarySteps(
  context: GarminSyncPlanContext,
): Promise<string[]> {
  const userId = resolveUserId(context);
  if (userId == null) return context.dates;

  const syncedDates = new Set(
    (
      await context.db
        .select({ date: dailyMetrics.date })
        .from(dailyMetrics)
        .where(
          and(
            eq(dailyMetrics.userId, userId),
            eq(dailyMetrics.providerId, context.providerId),
            isNotNull(dailyMetrics.steps),
            gte(dailyMetrics.date, context.sinceDate),
            lte(dailyMetrics.date, context.untilDate),
          ),
        )
    ).map((row) => row.date),
  );

  return context.dates.filter((date) => !syncedDates.has(date));
}

export async function listGarminDatesNeedingHrvSteps(
  context: GarminSyncPlanContext,
): Promise<string[]> {
  const userId = resolveUserId(context);
  if (userId == null) return context.dates;

  const syncedDates = new Set(
    (
      await context.db
        .select({ date: dailyMetrics.date })
        .from(dailyMetrics)
        .where(
          and(
            eq(dailyMetrics.userId, userId),
            eq(dailyMetrics.providerId, context.providerId),
            isNotNull(dailyMetrics.hrv),
            gte(dailyMetrics.date, context.sinceDate),
            lte(dailyMetrics.date, context.untilDate),
          ),
        )
    ).map((row) => row.date),
  );

  return context.dates.filter((date) => !syncedDates.has(date));
}

async function listGarminDatesWithMetricStreamChannel(
  context: GarminSyncPlanContext,
  channel: typeof STRESS | typeof HEART_RATE,
): Promise<Set<string>> {
  if (!process.env.CLICKHOUSE_URL) {
    return new Set();
  }

  const userId = resolveUserId(context);
  if (userId == null) {
    return new Set();
  }

  const client = createClickHouseClientFromEnv();
  try {
    const result = await client.query({
      query: `
        SELECT DISTINCT toString(toDate(recorded_at)) AS date
        FROM ingest.metric_stream FINAL
        WHERE user_id = {userId:UUID}
          AND provider_id = {providerId:String}
          AND channel = {channel:String}
          AND recorded_at >= parseDateTime64BestEffort({rangeStart:String})
          AND recorded_at < parseDateTime64BestEffort({rangeEnd:String})
          AND is_deleted = 0
      `,
      format: "JSONEachRow",
      query_params: {
        userId,
        providerId: context.providerId,
        channel,
        rangeStart: `${context.sinceDate}T00:00:00.000Z`,
        rangeEnd: dayAfterUtc(context.untilDate).toISOString(),
      },
    });
    const rows = z.array(metricStreamDateRowSchema).parse(await result.json());
    return new Set(rows.map((row) => row.date));
  } catch (error) {
    captureException(error, {
      tags: { provider: "garmin", operation: "metric_stream_date_query" },
      extra: { channel, providerId: context.providerId },
    });
    throw error;
  } finally {
    await client.close?.();
  }
}

export async function planGarminSyncSteps(
  context: GarminSyncPlanContext,
): Promise<GarminSyncStep[]> {
  const userId = resolveUserId(context);
  const pendingKeys =
    userId == null ? new Set<string>() : await listPendingSyncRequestQueryKeys("garmin", userId);

  const steps: GarminSyncStep[] = [];
  planSyncStepIfRequestNotPending(
    steps,
    { type: "activities_list", offset: 0 },
    garminSyncStepToApiQuery,
    pendingKeys,
  );

  const [sleepDates, dailySummaryDates, hrvDates, stressSyncedDates, heartRateSyncedDates] =
    await Promise.all([
      listGarminDatesNeedingSleepSteps(context),
      listGarminDatesNeedingDailySummarySteps(context),
      listGarminDatesNeedingHrvSteps(context),
      listGarminDatesWithMetricStreamChannel(context, STRESS),
      listGarminDatesWithMetricStreamChannel(context, HEART_RATE),
    ]);

  const sleepDateSet = new Set(sleepDates);
  const dailySummaryDateSet = new Set(dailySummaryDates);
  const hrvDateSet = new Set(hrvDates);

  for (const date of context.dates) {
    if (sleepDateSet.has(date)) {
      planSyncStepIfRequestNotPending(
        steps,
        { type: "sleep", date },
        garminSyncStepToApiQuery,
        pendingKeys,
      );
    }
    if (dailySummaryDateSet.has(date)) {
      planSyncStepIfRequestNotPending(
        steps,
        { type: "daily_summary", date },
        garminSyncStepToApiQuery,
        pendingKeys,
      );
    }
    if (hrvDateSet.has(date)) {
      planSyncStepIfRequestNotPending(
        steps,
        { type: "hrv_summary", date },
        garminSyncStepToApiQuery,
        pendingKeys,
      );
    }
    if (!stressSyncedDates.has(date)) {
      planSyncStepIfRequestNotPending(
        steps,
        { type: "stress", date },
        garminSyncStepToApiQuery,
        pendingKeys,
      );
    }
    if (!heartRateSyncedDates.has(date)) {
      planSyncStepIfRequestNotPending(
        steps,
        { type: "heart_rate", date },
        garminSyncStepToApiQuery,
        pendingKeys,
      );
    }
  }

  return steps;
}
