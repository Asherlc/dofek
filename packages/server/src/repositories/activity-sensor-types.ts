import type { z } from "zod";

export interface ActivitySensorWindow {
  activityId: string;
  userId: string;
  startedAt: string;
  endedAt: string | null;
  memberActivityIds: string[];
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
