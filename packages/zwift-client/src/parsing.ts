import type { CanonicalActivityType } from "@dofek/training/training";
import type { ZwiftActivitySummary, ZwiftFitnessData } from "./types.ts";

// ============================================================
// Parsed types
// ============================================================

export interface ParsedZwiftActivity {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

export interface ParsedZwiftStreamSample {
  recordedAt: Date;
  heartRate?: number;
  power?: number;
  cadence?: number;
  speed?: number; // m/s
  altitude?: number; // meters
  distance?: number; // cumulative meters
  lat?: number;
  lng?: number;
}

// ============================================================
// Parsing — pure functions
// ============================================================

export function mapZwiftSport(sport: string): CanonicalActivityType {
  switch (sport.toUpperCase()) {
    case "CYCLING":
      return "virtual_cycling";
    case "RUNNING":
      return "running";
    default:
      return "other";
  }
}

export function parseZwiftActivity(act: ZwiftActivitySummary): ParsedZwiftActivity {
  return {
    externalId: act.id_str || String(act.id),
    activityType: mapZwiftSport(act.sport),
    name: act.name,
    startedAt: new Date(act.startDate),
    endedAt: new Date(act.endDate),
    raw: {
      distanceMeters: act.distanceInMeters,
      avgHeartRate: act.avgHeartRate,
      maxHeartRate: act.maxHeartRate,
      avgWatts: act.avgWatts,
      maxWatts: act.maxWatts,
      avgCadence: act.avgCadenceInRotationsPerMinute,
      avgSpeed: act.avgSpeedInMetersPerSecond,
      maxSpeed: act.maxSpeedInMetersPerSecond,
      elevationGain: act.totalElevationInMeters,
      calories: act.calories,
    },
  };
}

export function parseZwiftFitnessData(
  data: ZwiftFitnessData,
  activityStart: Date,
): ParsedZwiftStreamSample[] {
  const samples: ParsedZwiftStreamSample[] = [];
  const times = data.timeInSec ?? [];
  const length = Math.max(
    times.length,
    data.powerInWatts?.length ?? 0,
    data.heartRate?.length ?? 0,
  );

  for (let i = 0; i < length; i++) {
    const offsetSec = times[i] ?? i;
    const recordedAt = new Date(activityStart.getTime() + offsetSec * 1000);
    const latlng = data.latlng?.[i];

    samples.push({
      recordedAt,
      heartRate: data.heartRate?.[i] ?? undefined,
      power: data.powerInWatts?.[i] ?? undefined,
      cadence: data.cadencePerMin?.[i] ?? undefined,
      speed: data.speedInCmPerSec?.[i] != null ? (data.speedInCmPerSec[i] ?? 0) / 100 : undefined,
      altitude: data.altitudeInCm?.[i] != null ? (data.altitudeInCm[i] ?? 0) / 100 : undefined,
      distance: data.distanceInCm?.[i] != null ? (data.distanceInCm[i] ?? 0) / 100 : undefined,
      lat: latlng?.[0] ?? undefined,
      lng: latlng?.[1] ?? undefined,
    });
  }

  return samples;
}
