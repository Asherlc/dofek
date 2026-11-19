import type { z } from "zod";
import {
  type recoveryTrainingFieldSchema,
  recoveryTrainingSeriesOutputSchema,
} from "./recovery-training-series-output.ts";

export const seriesRowsSchema = recoveryTrainingSeriesOutputSchema.shape.result.shape.rows;
type SeriesRow = z.infer<typeof seriesRowsSchema.element>;
export type SeriesField = z.infer<typeof recoveryTrainingFieldSchema>;
type SleepObservation = Extract<NonNullable<SeriesRow["sleep"]>, { status: "observed" }>;

const weekdayFormat = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });

function observedFields(row: SeriesRow): Record<string, boolean> {
  const weight = row.body_weight;
  const sleep = row.sleep?.status === "observed" ? row.sleep : null;
  const nutrition = row.nutrition;
  const activity = row.activity_exposure;
  return {
    ...(row.health && {
      health: Object.values(row.health).some((metric) => metric.status === "observed"),
      "health.hrv": row.health.hrv.status === "observed",
      "health.resting_hr": row.health.resting_hr.status === "observed",
      "health.respiratory_rate": row.health.respiratory_rate.status === "observed",
      "health.steps": row.health.steps.status === "observed",
    }),
    ...(row.sleep && {
      sleep: sleep !== null,
      "sleep.started_at": sleep !== null,
      "sleep.ended_at": sleep?.ended_at != null,
      "sleep.duration_minutes": sleep?.duration_minutes != null,
      "sleep.awake_minutes": sleep?.stages_minutes.awake != null,
    }),
    ...(weight && {
      body_weight: weight.direct_status === "observed",
      "body_weight.rolling.average_7d_kg": weight.rolling.average_7d_kg !== null,
    }),
    ...(row.training_load !== undefined && {
      training_load: Object.values(row.training_load ?? {}).some(
        (channel) => channel.daily_value !== null,
      ),
    }),
    ...(row.previous_day_training_load !== undefined && {
      previous_day_training_load: Object.values(row.previous_day_training_load ?? {}).some(
        (channel) => channel.daily_value !== null,
      ),
    }),
    ...(activity && {
      activity_exposure:
        activity.duration.value_minutes !== null || Boolean(activity.activity_count),
      "activity_exposure.duration": activity.duration.value_minutes !== null,
      ...("last_activity" in activity && {
        "activity_exposure.last_activity": activity.last_activity !== null,
      }),
    }),
    ...(nutrition && {
      nutrition: nutrition.logging_completeness !== "no_logging",
      "nutrition.total_calories": nutrition.total_calories !== null,
      "nutrition.protein_g": nutrition.protein_g !== null,
      "nutrition.carbs_g": nutrition.carbs_g !== null,
      "nutrition.fat_g": nutrition.fat_g !== null,
      "nutrition.fiber_g": nutrition.fiber_g !== null,
    }),
  };
}

export function formatSeriesPage(
  sourceRows: SeriesRow[],
  fields: readonly SeriesField[],
  options: { workoutFinishAfter?: string; cursor?: string; limit?: number },
) {
  const rows = sourceRows.map((row) => ({
    ...row,
    weekday: weekdayFormat.format(new Date(`${row.date}T00:00:00Z`)),
  }));
  const rowKey = (row: SeriesRow) => row.row_id ?? row.date;
  const after = options.cursor ? rows.findIndex((row) => rowKey(row) === options.cursor) + 1 : 0;
  if (options.cursor && after === 0) {
    throw new Error(
      "The cursor does not match this series. Reuse the original arguments or restart paging.",
    );
  }
  const end = Math.min(after + (options.limit ?? rows.length), rows.length);
  const selected = new Set<string>(fields);
  const observedCounts: Record<string, number> = Object.fromEntries(
    fields.map((field) => [field, 0]),
  );
  const workoutCounts = new Map<
    string,
    {
      weekday: string;
      before: number;
      at_or_after: number;
      unknown: number;
    }
  >();
  const threshold = options.workoutFinishAfter;
  const sourceChanges = [];
  let previousSleep: { date: string; observation: SleepObservation } | undefined;
  for (const row of rows) {
    for (const [field, observed] of Object.entries(observedFields(row))) {
      if (selected.has(field.split(".")[0] ?? "")) {
        observedCounts[field] = (observedCounts[field] ?? 0) + Number(observed);
      }
    }
    if (selected.has("sleep") && row.sleep?.status === "observed") {
      const { source_provider: provider, source_name: sourceName } = row.sleep;
      if (previousSleep) {
        const prior = previousSleep.observation;
        if (
          prior.source_provider !== provider ||
          (prior.source_name !== null && sourceName !== null && prior.source_name !== sourceName)
        ) {
          sourceChanges.push({
            previous_date: previousSleep.date,
            date: row.date,
            previous_provider: prior.source_provider,
            provider,
            previous_source_name: prior.source_name,
            source_name: sourceName,
          });
        }
      }
      previousSleep = { date: row.date, observation: row.sleep };
    }
    if (threshold) {
      const counts = workoutCounts.get(row.weekday) ?? {
        weekday: row.weekday,
        before: 0,
        at_or_after: 0,
        unknown: 0,
      };
      const activity = row.activity_exposure;
      const finish =
        activity && "last_activity" in activity ? activity.last_activity?.local_end_time : null;
      if (!finish) counts.unknown += 1;
      else if (finish >= threshold) counts.at_or_after += 1;
      else counts.before += 1;
      workoutCounts.set(row.weekday, counts);
    }
  }
  const lastRow = rows[end - 1];
  return {
    rows: rows.slice(after, end).map((row) => ({
      date: row.date,
      weekday: row.weekday,
      ...(row.row_id && { row_id: row.row_id }),
      ...(selected.has("sleep") &&
        row.sleep_episode_ids && { sleep_episode_ids: row.sleep_episode_ids }),
      ...Object.fromEntries(
        fields.flatMap((field) => (row[field] === undefined ? [] : [[field, row[field]]])),
      ),
    })),
    eligible_count: rows.length,
    observed_counts: observedCounts,
    ...(selected.has("sleep") && { sleep_source_changes: sourceChanges }),
    next_cursor: end < rows.length && lastRow ? rowKey(lastRow) : null,
    ...(threshold && { workout_finish_counts: [...workoutCounts.values()] }),
  };
}
