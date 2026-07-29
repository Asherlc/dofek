import {
  resolveProviderActivityType,
  type LegacyActivityType,
  type ProviderActivityType,
} from "@dofek/training/activity-types";
import type { XertActivity } from "./types.ts";

export interface ParsedXertActivity {
  externalId: string;
  activityType: ProviderActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  raw: Record<string, unknown>;
}

export const XERT_SPORT_MAP: Readonly<Record<string, LegacyActivityType>> = {
  Cycling: "cycling",
  Running: "running",
  Swimming: "swimming",
  Walking: "walking",
  Hiking: "hiking",
  Rowing: "rowing",
  Skiing: "skiing",
  "Virtual Cycling": "virtual_cycling",
  "Mountain Biking": "mountain_biking",
  "Trail Running": "trail_running",
  "Cross Country Skiing": "cross_country_skiing",
};

export function mapXertSport(sport: string): ProviderActivityType {
  return resolveProviderActivityType(sport, XERT_SPORT_MAP[sport] ?? "other");
}

export function parseXertActivity(activity: XertActivity): ParsedXertActivity {
  return {
    externalId: String(activity.id),
    activityType: mapXertSport(activity.sport),
    name: activity.name,
    startedAt: new Date(activity.startTimestamp * 1000),
    endedAt: new Date(activity.endTimestamp * 1000),
    raw: {
      sport: activity.sport,
      duration: activity.duration,
      distance: activity.distance,
      powerAvg: activity.power_avg,
      powerMax: activity.power_max,
      powerNormalized: activity.power_normalized,
      heartrateAvg: activity.heartrate_avg,
      heartrateMax: activity.heartrate_max,
      cadenceAvg: activity.cadence_avg,
      cadenceMax: activity.cadence_max,
      elevationGain: activity.elevation_gain,
      elevationLoss: activity.elevation_loss,
      xss: activity.xss,
      focus: activity.focus,
      difficulty: activity.difficulty,
    },
  };
}
