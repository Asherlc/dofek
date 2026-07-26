import { z } from "zod";
import {
  ALTITUDE,
  CADENCE,
  GRADE,
  GROUND_CONTACT_TIME,
  HEART_RATE,
  LEFT_PEDAL_SMOOTHNESS,
  LEFT_RIGHT_BALANCE,
  LEFT_TORQUE_EFFECTIVENESS,
  POWER,
  RIGHT_PEDAL_SMOOTHNESS,
  RIGHT_TORQUE_EFFECTIVENESS,
  SPEED,
  STANCE_TIME,
  STRIDE_LENGTH,
  VERTICAL_OSCILLATION,
} from "../db/sensor-channels.ts";

const activityScalarChannels = [
  HEART_RATE,
  POWER,
  SPEED,
  CADENCE,
  ALTITUDE,
  GRADE,
  LEFT_RIGHT_BALANCE,
  LEFT_TORQUE_EFFECTIVENESS,
  RIGHT_TORQUE_EFFECTIVENESS,
  LEFT_PEDAL_SMOOTHNESS,
  RIGHT_PEDAL_SMOOTHNESS,
  STANCE_TIME,
  VERTICAL_OSCILLATION,
  GROUND_CONTACT_TIME,
  STRIDE_LENGTH,
] as const;

const sourceBoundsRowsSchema = z.tuple([
  z.object({
    scalar_begin: z.string().date().nullable(),
    location_begin: z.string().date().nullable(),
  }),
]);

export interface AnalyticsMicrobatchBounds {
  sensor_scalar_sample_begin: string;
  deduped_sensor_begin: string;
  activity_sensor_sample_begin: string;
  activity_location_sample_begin: string;
}

export interface AnalyticsMicrobatchQueryClient {
  query(options: { query: string; format: "JSONEachRow" }): Promise<{ json(): Promise<unknown> }>;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

export async function resolveAnalyticsMicrobatchBounds(
  clickHouse: AnalyticsMicrobatchQueryClient,
  now: Date = new Date(),
): Promise<AnalyticsMicrobatchBounds> {
  const scalarChannelList = activityScalarChannels.map(sqlStringLiteral).join(", ");
  const result = await clickHouse.query({
    query: `SELECT
  toString(minIfOrNull(toDate(ingested_at), channel IN (${scalarChannelList}))) AS scalar_begin,
  toString(minIfOrNull(toDate(ingested_at), channel = 'location')) AS location_begin
FROM ingest.metric_stream`,
    format: "JSONEachRow",
  });
  const [sourceBounds] = sourceBoundsRowsSchema.parse(await result.json());
  const currentUtcDay = now.toISOString().slice(0, 10);
  const scalarBegin = sourceBounds.scalar_begin ?? currentUtcDay;
  const locationBegin = sourceBounds.location_begin ?? currentUtcDay;

  return {
    sensor_scalar_sample_begin: scalarBegin,
    deduped_sensor_begin: scalarBegin,
    activity_sensor_sample_begin: scalarBegin,
    activity_location_sample_begin: locationBegin,
  };
}
