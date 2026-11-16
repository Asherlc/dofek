import type { z } from "zod";

export interface ActivitySensorWindow {
  activityId: string;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  providerType: string | null;
  memberActivityIds: string[];
}

export interface StreamPointRow {
  recorded_at: string;
  heart_rate: number | null;
  power: number | null;
  speed: number | null;
  cadence: number | null;
  altitude: number | null;
  lat: number | null;
  lng: number | null;
  skin_temperature?: number | null;
  skin_temperature_recorded_at?: string | null;
}

export interface ActivitySensorQueryOptions {
  priority?: "dashboard";
  abortSignal?: AbortSignal | undefined;
}

export interface ActivitySensorQueryStore {
  /**
   * Run a raw ClickHouse query against the analytics database and parse rows
   * with the supplied Zod schema. Used by repositories that previously joined
   * fitness.deduped_sensor / fitness.activity_summary and now read from
   * analytics.deduped_sensor / analytics.activity_summary.
   */
  query<TSchema extends z.ZodType>(
    schema: TSchema,
    query: string,
    params?: Record<string, unknown>,
    options?: ActivitySensorQueryOptions,
  ): Promise<z.infer<TSchema>[]>;
}
