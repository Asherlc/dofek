import {
  type LegacyActivityType,
  type ProviderActivityType,
  resolveProviderActivityType,
} from "@dofek/training/activity-types";
import type { PelotonPerformanceGraph, PelotonWorkout } from "./types.ts";

const DISCIPLINE_MAP: Record<string, LegacyActivityType> = {
  cycling: "indoor_cycling",
  running: "running",
  walking: "walking",
  rowing: "rowing",
  caesar: "rowing",
  strength: "strength",
  yoga: "yoga",
  meditation: "meditation",
  stretching: "stretching",
  cardio: "cardio",
  bike_bootcamp: "bootcamp",
  tread_bootcamp: "bootcamp",
  outdoor: "running",
};

export function mapFitnessDiscipline(discipline: string): ProviderActivityType {
  return resolveProviderActivityType(discipline, DISCIPLINE_MAP[discipline] ?? "other");
}

export interface ParsedPelotonWorkout {
  externalId: string;
  activityType: ProviderActivityType;
  name?: string;
  timezone?: string;
  stravaId?: string;
  startedAt: Date;
  endedAt?: Date;
  raw: Record<string, unknown>;
}

export function parseWorkout(workout: PelotonWorkout): ParsedPelotonWorkout {
  const startedAt = new Date(workout.start_time * 1000);
  const endTime = workout.end_time ?? 0;
  const endedAt = endTime > 0 ? new Date(endTime * 1000) : undefined;
  const stravaId = workout.strava_id && workout.strava_id !== "-1" ? workout.strava_id : undefined;

  return {
    externalId: workout.id,
    activityType: mapFitnessDiscipline(workout.fitness_discipline),
    name: workout.ride?.title,
    timezone: workout.timezone || undefined,
    stravaId,
    startedAt,
    endedAt,
    raw: {
      instructor: workout.ride?.instructor?.name,
      classTitle: workout.ride?.title,
      difficultyRating: workout.ride?.difficulty_rating_avg,
      overallRating: workout.ride?.overall_rating_avg,
      rideDescription: workout.ride?.description,
      leaderboardRank: workout.leaderboard_rank,
      totalLeaderboardUsers: workout.total_leaderboard_users,
      totalWorkJoules: workout.total_work || undefined,
      isPersonalRecord: workout.is_total_work_personal_record || undefined,
      fitnessDiscipline: workout.fitness_discipline,
      pelotonRideId: workout.ride?.id,
      deviceType: workout.device_type || undefined,
      platform: workout.platform || undefined,
      pelotonClassId: workout.peloton_id || undefined,
      workoutType: workout.workout_type || undefined,
      hasPedalingMetrics: workout.has_pedaling_metrics,
      timezone: workout.timezone || undefined,
    },
  };
}

export interface ParsedMetricSeries {
  slug: string;
  displayName: string;
  values: number[];
  offsetsSeconds: number[];
  averageValue: number;
  maxValue: number;
}

export function parsePerformanceGraph(
  graph: PelotonPerformanceGraph,
  everyN: number,
): ParsedMetricSeries[] {
  return graph.metrics.map((metric) => ({
    slug: metric.slug,
    displayName: metric.display_name,
    values: metric.values,
    offsetsSeconds: metric.values.map((_, index) => index * everyN),
    averageValue: metric.average_value,
    maxValue: metric.max_value,
  }));
}
