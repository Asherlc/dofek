import { summarizeIntervalPower } from "@dofek/training/cycling-interval-power";
import type { Database } from "dofek/db";
import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";
import type { ActivitySensorWindow } from "./activity-sensor-types.ts";
import {
  type CyclingEffortSample,
  loadRecordedIntervalRows,
  type RecordedIntervalEvidence,
  recordedIntervalsForActivity,
  resampleCleanPower,
} from "./cycling-effort-metrics.ts";
import { loadCyclingSampleRows } from "./cycling-sample-rows.ts";
import type { ComparableInterval } from "./intervals-repository.ts";

/**
 * Server-authored planned-versus-recorded lap, shared by the cycling MCP tool and
 * `intervals.plannedByActivity`. Planned time, recorded timer and target come from one source row.
 */
export const plannedIntervalComparisonSchema = z.object({
  intervalIndex: z.number().int(),
  label: z.string().nullable(),
  /** Signed exact elapsed bounds of the recorded lap, relative to the canonical activity start. */
  startOffsetSeconds: z.number(),
  endOffsetSeconds: z.number().positive(),
  sourceProvider: z.string().nullable(),
  sourceActivityId: z.string().uuid().nullable(),
  sourceMemberActivityIds: z.array(z.string().uuid()),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("point"), watts: z.number() }),
    z.object({ kind: z.literal("range"), minWatts: z.number(), maxWatts: z.number() }),
  ]),
  plannedDurationSeconds: z.number().positive(),
  recordedTimerDurationSeconds: z.number().nonnegative().nullable(),
  /** Recorded timer seconds minus planned seconds; null when no timer was recorded. */
  timerDifferenceSeconds: z.number().nullable(),
  /** Gap-aware mean over the actual half-open lap window; null without measured samples. */
  averagePowerWatts: z.number().nullable(),
});

export type PlannedIntervalComparison = z.infer<typeof plannedIntervalComparisonSchema>;

export function toPlannedIntervalComparison(
  averagePowerWatts: number | null,
  evidence: ComparableInterval | null | undefined,
  windowSeconds: number,
): PlannedIntervalComparison | null {
  const plan = evidence?.plan;
  if (!evidence || !plan) return null;
  // Semantic overlap with the visible window uses the exact bounds, independent of which 1 Hz
  // timestamps were selected: a lap wholly outside it has nothing to compare.
  if (
    windowSeconds <= 0 ||
    evidence.endOffsetSeconds <= 0 ||
    evidence.startOffsetSeconds >= windowSeconds
  ) {
    return null;
  }
  const timer = plan.recordedTimerDurationSeconds;
  return {
    intervalIndex: evidence.intervalIndex,
    label: evidence.label,
    startOffsetSeconds: evidence.startOffsetSeconds,
    endOffsetSeconds: evidence.endOffsetSeconds,
    sourceProvider: evidence.sourceProvider,
    sourceActivityId: evidence.sourceActivityId,
    sourceMemberActivityIds: evidence.sourceMemberActivityIds,
    target: plan.target,
    plannedDurationSeconds: plan.plannedDurationSeconds,
    recordedTimerDurationSeconds: timer,
    timerDifferenceSeconds:
      timer == null ? null : Math.round((timer - plan.plannedDurationSeconds) * 1000) / 1000,
    averagePowerWatts,
  };
}

/** Exact continuous length of the canonical window; an open window ends at its last plan lap. */
export function canonicalWindowSeconds(
  startedAt: string,
  endedAt: string | null,
  intervals: readonly RecordedIntervalEvidence[],
): number {
  if (endedAt != null) return (Date.parse(endedAt) - Date.parse(startedAt)) / 1_000;
  return Math.max(
    0,
    ...intervals.filter(({ interval }) => interval.plan).map(({ input }) => input.endOffsetSeconds),
  );
}

/**
 * The one comparison calculation shared by the route and the MCP tool: gap-aware power from
 * already loaded samples over the exact canonical window, aligned by position with `intervals`.
 * No work is done without an eligible plan; rows without one are null.
 */
export function comparePlannedIntervals(
  samples: CyclingEffortSample[],
  intervals: readonly RecordedIntervalEvidence[],
  windowSeconds: number,
): Array<PlannedIntervalComparison | null> {
  if (!intervals.some(({ interval }) => interval.plan)) return intervals.map(() => null);
  // The exact window selects eligibility; its ceil is the 1 Hz array length.
  const power = resampleCleanPower(samples, Math.max(0, Math.ceil(windowSeconds)));
  return intervals.map(({ input, interval }) => {
    if (!interval.plan) return null;
    const { averagePowerWatts } = summarizeIntervalPower(power.values, input);
    return toPlannedIntervalComparison(averagePowerWatts, interval, windowSeconds);
  });
}

/**
 * Comparisons for one already authorized canonical activity window. Reads only the stored plans
 * first, then deduplicated power for this activity when at least one eligible plan exists.
 */
export async function getPlannedIntervalComparisons(
  db: Pick<Database, "execute">,
  store: Pick<ActivitySensorStore, "query">,
  userId: string,
  window: ActivitySensorWindow,
): Promise<PlannedIntervalComparison[]> {
  const eligible = recordedIntervalsForActivity(
    {
      activity_id: window.activityId,
      member_activity_ids: window.memberActivityIds,
      started_at: window.startedAt,
    },
    await loadRecordedIntervalRows(db, window.memberActivityIds),
  ).filter(({ interval }) => interval.plan != null);
  if (eligible.length === 0) return [];

  const rows = await loadCyclingSampleRows(
    store,
    userId,
    [window.activityId],
    ["power"],
    window.startedAt,
  );
  const samples: CyclingEffortSample[] = rows.map((row) => ({
    elapsedSeconds: row.elapsed_seconds,
    powerWatts: row.stream_evidence.some(([channel]) => channel === "power")
      ? row.power
      : undefined,
  }));
  return comparePlannedIntervals(
    samples,
    eligible,
    canonicalWindowSeconds(window.startedAt, window.endedAt, eligible),
  ).flatMap((comparison) => (comparison ? [comparison] : []));
}
