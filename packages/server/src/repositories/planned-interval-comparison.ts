import { summarizeIntervalPower } from "@dofek/training/cycling-workout-metrics";
import type { Database } from "dofek/db";
import { z } from "zod";
import type { ActivitySensorStore } from "./activity-repository.ts";
import type { ActivitySensorWindow } from "./activity-sensor-types.ts";
import {
  type CyclingEffortSample,
  loadRecordedIntervalRows,
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
  startOffsetSeconds: z.number().int().nonnegative(),
  endOffsetSeconds: z.number().int().nonnegative(),
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

interface MeasuredInterval {
  index: number;
  label: string | null;
  startOffsetSeconds: number;
  endOffsetSeconds: number;
  averagePowerWatts: number | null;
}

export function toPlannedIntervalComparison(
  measured: MeasuredInterval,
  evidence: ComparableInterval | null | undefined,
): PlannedIntervalComparison | null {
  const plan = evidence?.plan;
  if (!evidence || !plan) return null;
  const timer = plan.recordedTimerDurationSeconds;
  return {
    intervalIndex: measured.index,
    label: measured.label,
    startOffsetSeconds: measured.startOffsetSeconds,
    endOffsetSeconds: measured.endOffsetSeconds,
    sourceProvider: evidence.sourceProvider,
    sourceActivityId: evidence.sourceActivityId,
    sourceMemberActivityIds: evidence.sourceMemberActivityIds,
    target: plan.target,
    plannedDurationSeconds: plan.plannedDurationSeconds,
    recordedTimerDurationSeconds: timer,
    timerDifferenceSeconds:
      timer == null ? null : Math.round((timer - plan.plannedDurationSeconds) * 1000) / 1000,
    averagePowerWatts: measured.averagePowerWatts,
  };
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
  const startedAt = Date.parse(window.startedAt);
  const activity = {
    activity_id: window.activityId,
    member_activity_ids: window.memberActivityIds,
    started_at: window.startedAt,
  };
  const eligible = recordedIntervalsForActivity(
    activity,
    await loadRecordedIntervalRows(db, window.memberActivityIds),
  ).filter(({ interval }) => interval.plan != null);
  if (eligible.length === 0) return [];

  const lastLapEnd = Math.max(...eligible.map(({ input }) => input.endOffsetSeconds));
  const durationSeconds =
    window.endedAt == null
      ? lastLapEnd
      : Math.max(0, Math.floor((Date.parse(window.endedAt) - startedAt) / 1_000));
  const rows = await loadCyclingSampleRows(store, userId, [window.activityId], ["power"]);
  const samples: CyclingEffortSample[] = rows.map((row) => ({
    elapsedSeconds: row.elapsed_seconds,
    powerWatts: row.stream_evidence.some(([channel]) => channel === "power")
      ? row.power
      : undefined,
  }));
  const power = resampleCleanPower(samples, durationSeconds);
  return eligible.flatMap(({ input, interval }) => {
    const measured = summarizeIntervalPower(power.values, input);
    // A merged lap with no overlap with the visible canonical window has nothing to compare.
    if (measured.endOffsetSeconds <= measured.startOffsetSeconds) return [];
    const comparison = toPlannedIntervalComparison(
      { index: input.index, label: input.label ?? null, ...measured },
      interval,
    );
    return comparison ? [comparison] : [];
  });
}
