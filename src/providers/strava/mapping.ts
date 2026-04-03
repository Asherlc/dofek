import { isIndoorCycling } from "@dofek/training/endurance-types";
import {
  type CanonicalActivityType,
  createActivityTypeMapper,
  STRAVA_ACTIVITY_TYPE_MAP,
} from "@dofek/training/training";
import type { SensorSampleSourceRow } from "../../db/sensor-sample-writer.ts";
import type { StravaActivity, StravaStream, StravaStreamSet } from "./types.ts";

const mapStravaType = createActivityTypeMapper(STRAVA_ACTIVITY_TYPE_MAP);

/**
 * Map a Strava activity to its canonical type.
 * When sport_type is "Ride" and trainer is true, override to indoor_cycling
 * (covers spin bikes and other stationary trainers recorded via Strava).
 */
export function mapStravaActivityType(sportType: string, trainer = false): CanonicalActivityType {
  if (sportType === "Ride" && trainer) return "indoor_cycling";
  return mapStravaType(sportType);
}

// ============================================================
// Parsing / mapping (pure functions, easy to test)
// ============================================================

export interface ParsedStravaActivity {
  externalId: string;
  activityType: CanonicalActivityType;
  name: string;
  startedAt: Date;
  endedAt: Date;
  sourceName: string | undefined;
}

export function parseStravaActivity(act: StravaActivity): ParsedStravaActivity {
  const startedAt = new Date(act.start_date);
  return {
    externalId: String(act.id),
    activityType: mapStravaActivityType(act.sport_type, act.trainer),
    name: act.name,
    startedAt,
    endedAt: new Date(startedAt.getTime() + act.elapsed_time * 1000),
    sourceName: act.device_name,
  };
}

export interface ParsedStravaActivityList {
  activities: ParsedStravaActivity[];
  hasMore: boolean;
}

export function parseStravaActivityList(
  activities: StravaActivity[],
  perPage: number,
): ParsedStravaActivityList {
  return {
    activities: activities.map(parseStravaActivity),
    hasMore: activities.length >= perPage,
  };
}

// ============================================================
// Streams → metric_stream mapping
// ============================================================

export function stravaStreamsToMetricStream(
  streams: StravaStreamSet,
  providerId: string,
  activityId: string,
  startedAt: Date,
  activityType?: string,
): SensorSampleSourceRow[] {
  // Scalar streams contain number[], latlng contains [number, number][]
  function isScalarArray(data: number[] | [number, number][]): data is number[] {
    return data.length === 0 || !Array.isArray(data[0]);
  }
  function isTupleArray(data: number[] | [number, number][]): data is [number, number][] {
    return data.length > 0 && Array.isArray(data[0]);
  }
  function scalarData(s: StravaStream | undefined): number[] | undefined {
    if (!s?.data) return undefined;
    return isScalarArray(s.data) ? s.data : undefined;
  }
  function tupleData(s: StravaStream | undefined): [number, number][] | undefined {
    if (!s?.data) return undefined;
    return isTupleArray(s.data) ? s.data : undefined;
  }
  const timeData = scalarData(streams.time);
  if (!timeData || timeData.length === 0) return [];

  const heartrates = scalarData(streams.heartrate);
  const watts = scalarData(streams.watts);
  const cadences = scalarData(streams.cadence);
  const speeds = scalarData(streams.velocity_smooth);
  const latlngs = tupleData(streams.latlng);
  const altitudes = scalarData(streams.altitude);
  const distances = scalarData(streams.distance);
  const temps = scalarData(streams.temp);
  const grades = scalarData(streams.grade_smooth);

  return timeData.map((timeOffset, i) => {
    const latlng = latlngs?.[i];

    const raw: Record<string, unknown> = { time: timeOffset };
    if (heartrates?.[i] !== undefined) raw.heartrate = heartrates[i];
    if (watts?.[i] !== undefined) raw.watts = watts[i];
    if (cadences?.[i] !== undefined) raw.cadence = cadences[i];
    if (speeds?.[i] !== undefined) raw.velocity_smooth = speeds[i];
    if (latlng !== undefined) raw.latlng = latlng;
    if (altitudes?.[i] !== undefined) raw.altitude = altitudes[i];
    if (distances?.[i] !== undefined) raw.distance = distances[i];
    if (temps?.[i] !== undefined) raw.temp = temps[i];
    if (grades?.[i] !== undefined) raw.grade_smooth = grades[i];

    return {
      providerId,
      activityId,
      recordedAt: new Date(startedAt.getTime() + timeOffset * 1000),
      heartRate: heartrates?.[i],
      power: watts?.[i],
      cadence: cadences?.[i],
      speed: activityType && isIndoorCycling(activityType) ? undefined : speeds?.[i],
      lat: latlng?.[0],
      lng: latlng?.[1],
      altitude: altitudes?.[i],
      temperature: temps?.[i],
      grade: grades?.[i],
      raw,
    };
  });
}
