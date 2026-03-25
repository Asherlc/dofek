import type { CanonicalActivityType } from "@dofek/training/training";
import { mapVeloHeroSport } from "./sports.ts";
import type { VeloHeroWorkout } from "./types.ts";

export interface ParsedVeloHeroWorkout {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

/**
 * Parse a duration string in HH:MM:SS format to total seconds.
 */
export function parseDurationToSeconds(durTime: string): number {
  const parts = durTime.split(":");
  if (parts.length !== 3) return 0;
  const hours = Number.parseInt(parts[0] ?? "0", 10);
  const minutes = Number.parseInt(parts[1] ?? "0", 10);
  const seconds = Number.parseInt(parts[2] ?? "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Parse a numeric string, returning undefined if empty/invalid.
 */
function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value || value.trim() === "") return undefined;
  const num = Number.parseFloat(value);
  return Number.isNaN(num) ? undefined : num;
}

export function parseVeloHeroWorkout(workout: VeloHeroWorkout): ParsedVeloHeroWorkout {
  const durationSeconds = parseDurationToSeconds(workout.dur_time);

  // Build startedAt from date_ymd + start_time
  const dateStr = workout.date_ymd;
  const timeStr = workout.start_time || "00:00:00";
  const startedAt = new Date(`${dateStr}T${timeStr}`);
  const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  const distanceKm = parseOptionalNumber(workout.dist_km);
  const distanceMeters = distanceKm !== undefined ? Math.round(distanceKm * 1000) : undefined;
  const avgHeartRate = parseOptionalNumber(workout.avg_hr);
  const maxHeartRate = parseOptionalNumber(workout.max_hr);
  const avgPower = parseOptionalNumber(workout.avg_power);
  const maxPower = parseOptionalNumber(workout.max_power);
  const avgCadence = parseOptionalNumber(workout.avg_cadence);
  const maxCadence = parseOptionalNumber(workout.max_cadence);
  const calories = parseOptionalNumber(workout.calories);
  const ascent = parseOptionalNumber(workout.ascent);
  const descent = parseOptionalNumber(workout.descent);

  return {
    externalId: String(workout.id),
    activityType: mapVeloHeroSport(workout.sport_id),
    name: workout.title || `${mapVeloHeroSport(workout.sport_id)} workout`,
    startedAt,
    endedAt,
    raw: {
      sportId: workout.sport_id,
      durationSeconds,
      distanceMeters,
      avgHeartRate,
      maxHeartRate,
      avgPower,
      maxPower,
      avgCadence,
      maxCadence,
      calories,
      ascent,
      descent,
    },
  };
}
