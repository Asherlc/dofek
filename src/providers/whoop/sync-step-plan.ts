import { and, eq, isNotNull } from "drizzle-orm";
import type { WhoopCycle, WhoopWorkoutRecord } from "whoop-whoop/types";
import { dailyMetrics, sleepSession, sleepStage } from "../../db/schema.ts";
import { getTokenUserId } from "../../db/token-user-context.ts";
import { extractSleepIdsFromCycle, resolveWhoopWorkoutExternalId } from "./parsing.ts";
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

export async function listWhoopStepDatesNeedingSteps(
  context: Pick<WhoopSyncContext, "db" | "providerId" | "since" | "windowEnd" | "options">,
): Promise<string[]> {
  const userId = context.options?.userId ?? getTokenUserId();
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

export async function planWhoopApiSteps(
  context: WhoopPersistenceContext,
  skipRemainingAfterRateLimit: boolean,
): Promise<WhoopSyncStep[]> {
  const steps: WhoopSyncStep[] = [];

  for (const date of await listWhoopStepDatesNeedingSteps(context)) {
    steps.push({ type: "strain_deep_dive", date });
  }

  for (const sleepId of await listWhoopSleepIdsNeedingStages(context)) {
    steps.push({ type: "sleep_stages", sleepId });
  }

  steps.push({ type: "developer_workouts" });
  steps.push({ type: "persist_workouts" });

  for (const workout of collectWhoopWorkouts(context.cycles)) {
    const activityId = resolveWhoopWorkoutExternalId(workout);
    if (activityId) {
      steps.push({ type: "weightlifting", activityId });
    }
  }

  if (!skipRemainingAfterRateLimit) {
    for (const window of listWhoopHeartRateWindows(context.since, context.windowEnd.getTime())) {
      steps.push({ type: "heart_rate", start: window.start, end: window.end });
    }
    steps.push({ type: "journal" });
  }

  return steps;
}
