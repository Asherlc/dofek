export interface StravaActivity {
  id: number;
  name: string;
  type: string;
  sport_type: string;
  start_date: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  total_elevation_gain: number;
  average_speed?: number;
  max_speed?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  max_watts?: number;
  weighted_average_watts?: number;
  kilojoules?: number;
  average_cadence?: number;
  suffer_score?: number;
  calories?: number;
  start_latlng?: [number, number];
  end_latlng?: [number, number];
  trainer: boolean;
  commute: boolean;
  manual: boolean;
  gear_id?: string;
  device_watts?: boolean;
  /** Recording device name — only present on detailed activity responses. */
  device_name?: string;
}

/** Detailed activity response from GET /activities/{id}. */
export interface StravaDetailedActivity extends StravaActivity {
  device_name?: string;
}

export interface StravaStream {
  data: number[] | [number, number][];
  series_type: string;
  resolution: string;
  original_size: number;
}

export interface StravaStreamSet {
  time?: StravaStream;
  heartrate?: StravaStream;
  watts?: StravaStream;
  cadence?: StravaStream;
  velocity_smooth?: StravaStream;
  latlng?: StravaStream;
  altitude?: StravaStream;
  distance?: StravaStream;
  temp?: StravaStream;
  grade_smooth?: StravaStream;
}

export const STREAM_KEYS = new Set<string>([
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
