import type { CanonicalActivityType } from "@dofek/training/training";
import type { TrainerRoadActivity } from "./types.ts";

export interface ParsedTrainerRoadActivity {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

export function mapTrainerRoadActivityType(
  activityType: string,
  isOutside: boolean,
): CanonicalActivityType {
  const type = activityType.toLowerCase();
  if (type.includes("ride") || type.includes("cycling")) {
    return isOutside ? "cycling" : "virtual_cycling";
  }
  if (type.includes("run")) return "running";
  if (type.includes("swim")) return "swimming";
  return "other";
}

export function parseTrainerRoadActivity(act: TrainerRoadActivity): ParsedTrainerRoadActivity {
  const completedAt = new Date(act.CompletedDate);
  const startedAt = new Date(completedAt.getTime() - act.Duration * 1000);

  return {
    externalId: String(act.Id),
    activityType: mapTrainerRoadActivityType(act.ActivityType, act.IsOutside),
    name: act.WorkoutName,
    startedAt,
    endedAt: completedAt,
    raw: {
      tss: act.Tss,
      distanceMeters: act.DistanceInMeters,
      normalizedPower: act.NormalizedPower,
      avgPower: act.AveragePower,
      maxPower: act.MaxPower,
      avgHeartRate: act.AverageHeartRate,
      maxHeartRate: act.MaxHeartRate,
      avgCadence: act.AverageCadence,
      maxCadence: act.MaxCadence,
      calories: act.Calories,
      elevationGain: act.ElevationGainInMeters,
      avgSpeed: act.AverageSpeed,
      maxSpeed: act.MaxSpeed,
      intensityFactor: act.IfFactor,
      isOutside: act.IsOutside,
    },
  };
}
