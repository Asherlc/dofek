import {
  type CanonicalActivityType,
  createActivityTypeMapper,
  WAHOO_WORKOUT_TYPE_MAP,
} from "@dofek/training/training";
import type { WahooWorkout, WahooWorkoutListResponse } from "./client.ts";

// ============================================================
// Activity type mapping
// ============================================================

const mapWahooWorkoutType = createActivityTypeMapper(WAHOO_WORKOUT_TYPE_MAP);

function mapWorkoutType(typeId: number): CanonicalActivityType {
  return mapWahooWorkoutType(typeId);
}

// ============================================================
// Parsing / mapping (pure functions, easy to test)
// ============================================================

export interface ParsedCardioActivity {
  externalId: string;
  activityType: CanonicalActivityType;
  name?: string;
  startedAt: Date;
  endedAt?: Date;
  fitFileUrl?: string;
}

export function parseWorkoutSummary(workout: WahooWorkout): ParsedCardioActivity {
  const summary = workout.workout_summary;

  return {
    externalId: String(workout.id),
    activityType: mapWorkoutType(workout.workout_type_id),
    name: workout.name,
    startedAt: new Date(workout.starts),
    endedAt: summary?.duration_total_accum
      ? new Date(new Date(workout.starts).getTime() + summary.duration_total_accum * 1000)
      : undefined,
    fitFileUrl: summary?.file?.url,
  };
}

export interface ParsedWorkoutList {
  workouts: ParsedCardioActivity[];
  total: number;
  page: number;
  perPage: number;
  hasMore: boolean;
}

export function parseWorkoutList(response: WahooWorkoutListResponse): ParsedWorkoutList {
  return {
    workouts: response.workouts.map(parseWorkoutSummary),
    total: response.total,
    page: response.page,
    perPage: response.per_page,
    hasMore: response.page * response.per_page < response.total,
  };
}

// ============================================================
// FIT record → metric_stream mapping
// ============================================================
