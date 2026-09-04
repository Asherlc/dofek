import type { WhoopCycle, WhoopWorkoutRecord } from "@dofek/whoop/types";
import { and, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import { dailyMetrics, sleepSession, sleepStage } from "../../db/schema/activity.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { planSyncStepIfRequestNotPending } from "../../lib/sync-request-query.ts";
import { listPendingSyncRequestQueryKeys } from "../../lib/sync-request-queue.ts";
import { normalizeWhoopDay } from "./cycle-day.ts";
import { extractSleepIdsFromCycle, resolveWhoopWorkoutExternalId } from "./parsing.ts";
import { whoopSyncStepToApiQuery } from "./sync-api-query.ts";
import type { WhoopSyncStep } from "./sync-checkpoint.ts";
import type { WhoopPersistenceContext, WhoopSyncContext } from "./sync-types.ts";

export function* iterateUtcDates(start: Date, endMs: number): Generator<string> {
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  const end = new Date(endMs);
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());

  while (cursor.getTime() <= endDay) {
    yield cursor.toISOString().slice(0, 10);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

function collectWhoopWorkouts(cycles: WhoopCycle[]): WhoopWorkoutRecord[] {
  const workouts: WhoopWorkoutRecord[] = [];
  for (const cycle of cycles) {
    workouts.push(...(cycle.workouts ?? cycle.strain?.workouts ?? []));
  }
  return workouts;
}

function resolveDetailedSyncStart(context: WhoopPersistenceContext): Date | null {
  if (context.since.getTime() !== 0) {
    return context.since;
  }

  let earliestObservedMs = Number.POSITIVE_INFINITY;
  for (const cycle of context.cycles) {
    let earliestCycleDayMs = Number.POSITIVE_INFINITY;
    for (const cycleDay of cycle.days ?? []) {
      const normalizedCycleDay = normalizeWhoopDay(cycleDay);
      if (normalizedCycleDay) {
        earliestCycleDayMs = Math.min(earliestCycleDayMs, Date.parse(normalizedCycleDay));
      }
    }

    if (Number.isFinite(earliestCycleDayMs)) {
      earliestObservedMs = Math.min(earliestObservedMs, earliestCycleDayMs);
      continue;
    }

    const recoveryDay = normalizeWhoopDay(cycle.recovery?.created_at);
    if (recoveryDay) {
      earliestObservedMs = Math.min(earliestObservedMs, Date.parse(recoveryDay));
    }
  }

  if (!Number.isFinite(earliestObservedMs)) {
    return null;
  }

  const earliestObserved = new Date(earliestObservedMs);
  return new Date(
    Date.UTC(
      earliestObserved.getUTCFullYear(),
      earliestObserved.getUTCMonth(),
      earliestObserved.getUTCDate(),
    ),
  );
}

export async function listWhoopStepDatesNeedingSteps(
  context: Pick<WhoopSyncContext, "db" | "providerId" | "since" | "windowEnd" | "options">,
): Promise<string[]> {
  const userId = context.options?.userId ?? getTokenUserId();
  const sinceDate = context.since.toISOString().slice(0, 10);
  const untilDate = context.windowEnd.toISOString().slice(0, 10);
  const syncedStepDates =
    userId == null
      ? new Set<string>()
      : new Set(
          (
            await context.db
              .select({ date: dailyMetrics.date })
              .from(dailyMetrics)
              .where(
                and(
                  eq(dailyMetrics.userId, userId),
                  eq(dailyMetrics.providerId, context.providerId),
                  isNotNull(dailyMetrics.steps),
                  gte(dailyMetrics.date, sinceDate),
                  lte(dailyMetrics.date, untilDate),
                ),
              )
          ).map((row) => row.date),
        );

  const dates: string[] = [];
  for (const date of iterateUtcDates(context.since, context.windowEnd.getTime())) {
    if (!syncedStepDates.has(date)) {
      dates.push(date);
    }
  }
  return dates;
}

export async function listWhoopSleepIdsNeedingStages(
  context: Pick<WhoopSyncContext, "db" | "cycles" | "providerId" | "options">,
): Promise<string[]> {
  const sleepIds = new Set<string>();
  for (const cycle of context.cycles) {
    for (const id of extractSleepIdsFromCycle(cycle)) {
      sleepIds.add(id);
    }
  }

  if (sleepIds.size === 0) {
    return [];
  }

  const candidateSleepIds = [...sleepIds];
  const userId = context.options?.userId ?? getTokenUserId();
  const syncedSleepIds =
    userId == null
      ? new Set<string>()
      : new Set(
          (
            await context.db
              .select({ externalId: sleepSession.externalId })
              .from(sleepSession)
              .innerJoin(sleepStage, eq(sleepStage.sessionId, sleepSession.id))
              .where(
                and(
                  eq(sleepSession.userId, userId),
                  eq(sleepSession.providerId, context.providerId),
                  isNotNull(sleepSession.externalId),
                  inArray(sleepSession.externalId, candidateSleepIds),
                ),
              )
          )
            .map((row) => row.externalId)
            .filter((externalId): externalId is string => externalId != null),
        );

  return [...sleepIds].filter((id) => !syncedSleepIds.has(id));
}

export function listWhoopHeartRateWindows(
  since: Date,
  untilMs: number,
): Array<{ start: string; end: string }> {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const windows: Array<{ start: string; end: string }> = [];
  let windowStart = since.getTime();
  while (windowStart < untilMs) {
    const windowEnd = Math.min(windowStart + weekMs, untilMs);
    windows.push({
      start: new Date(windowStart).toISOString(),
      end: new Date(windowEnd).toISOString(),
    });
    windowStart = windowEnd;
  }
  return windows;
}

function planWhoopStepIfNotQueued(
  steps: WhoopSyncStep[],
  step: WhoopSyncStep,
  context: WhoopPersistenceContext,
  pendingKeys: ReadonlySet<string>,
): void {
  planSyncStepIfRequestNotPending(
    steps,
    step,
    (candidate) => whoopSyncStepToApiQuery(candidate, context),
    pendingKeys,
  );
}

export async function planWhoopApiSteps(
  context: WhoopPersistenceContext,
): Promise<WhoopSyncStep[]> {
  const userId = context.options?.userId ?? getTokenUserId();
  const pendingKeys =
    userId == null ? new Set<string>() : await listPendingSyncRequestQueryKeys("whoop", userId);

  const steps: WhoopSyncStep[] = [];

  const detailedSyncStart = resolveDetailedSyncStart(context);

  if (detailedSyncStart) {
    for (const date of await listWhoopStepDatesNeedingSteps({
      ...context,
      since: detailedSyncStart,
    })) {
      planWhoopStepIfNotQueued(steps, { type: "strain_deep_dive", date }, context, pendingKeys);
    }
  }

  planWhoopStepIfNotQueued(steps, { type: "developer_workouts" }, context, pendingKeys);
  planWhoopStepIfNotQueued(steps, { type: "persist_workouts" }, context, pendingKeys);

  for (const workout of collectWhoopWorkouts(context.cycles)) {
    const activityId = resolveWhoopWorkoutExternalId(workout);
    if (activityId) {
      planWhoopStepIfNotQueued(steps, { type: "weightlifting", activityId }, context, pendingKeys);
    }
  }

  for (const sleepId of await listWhoopSleepIdsNeedingStages(context)) {
    planWhoopStepIfNotQueued(steps, { type: "sleep_stages", sleepId }, context, pendingKeys);
  }

  for (const window of listWhoopHeartRateWindows(
    detailedSyncStart ?? context.windowEnd,
    context.windowEnd.getTime(),
  )) {
    planWhoopStepIfNotQueued(
      steps,
      { type: "heart_rate", start: window.start, end: window.end },
      context,
      pendingKeys,
    );
  }
  planWhoopStepIfNotQueued(steps, { type: "journal" }, context, pendingKeys);

  return steps;
}
