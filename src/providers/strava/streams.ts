import type { StravaStreamSet } from "./api-types.ts";

const STREAM_KEYS = new Set<string>([
  "time",
  "heartrate",
  "watts",
  "cadence",
  "velocity_smooth",
  "latlng",
  "altitude",
  "distance",
  "temp",
  "grade_smooth",
]);

export function isStreamKey(key: string): key is keyof StravaStreamSet {
  return STREAM_KEYS.has(key);
}
