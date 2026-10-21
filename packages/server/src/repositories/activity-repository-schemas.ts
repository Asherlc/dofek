import { localTimeSourceSchema } from "@dofek/format/record-local-time";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { activityOriginColumnsSchema } from "../models/activity-origin.ts";
import { activitySourceSchema } from "../models/activity-source.ts";

export const activityListRowSchema = z.object({
  id: z.string(),
  canonical_type: z.string(),
  provider_type: z.string(),
  modality: z.string().nullable().optional().default(null),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  name: z.string().nullable(),
  provider_id: z.string(),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().nullable(),
  end_utc_offset_minutes: z.coerce.number().nullable(),
  local_time_source: localTimeSourceSchema,
  source_providers: z.array(z.string()),
  member_activity_ids: z.array(z.string()).optional().default([]),
  avg_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  avg_power: z.number().nullable(),
  distance_meters: z.number().nullable(),
  elevation_gain_m: z.number().nullable().default(null),
  total_count: z.coerce.number(),
});

export const activityListColumns = sql`
  a.id,
  a.canonical_type,
  a.provider_type,
  a.modality::text AS modality,
  a.started_at::text AS started_at,
  a.ended_at::text AS ended_at,
  a.name,
  a.provider_id,
  a.timezone,
  a.start_utc_offset_minutes,
  a.end_utc_offset_minutes,
  a.local_time_source,
  a.source_providers,
  a.member_activity_ids,
  NULL::double precision AS avg_hr,
  NULL::smallint AS max_hr,
  NULL::double precision AS avg_power,
  NULL::double precision AS distance_meters,
  NULL::double precision AS elevation_gain_m,
  COUNT(*) OVER()::int AS total_count
`;

export const activityDetailRowSchema = z.object({
  ...activityOriginColumnsSchema.shape,
  id: z.string(),
  displayed_date: dateStringSchema,
  canonical_type: z.string(),
  raw_type: z.string(),
  modality: z.string().nullable().optional().default(null),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  name: z.string().nullable(),
  notes: z.string().nullable(),
  perceived_exertion: z.number().nullable(),
  provider_id: z.string(),
  timezone: z.string().nullable(),
  start_utc_offset_minutes: z.coerce.number().nullable(),
  end_utc_offset_minutes: z.coerce.number().nullable(),
  local_time_source: localTimeSourceSchema,
  subsource: z.string().nullable(),
  source_providers: z.array(z.string()),
  source_external_ids: z.array(activitySourceSchema).nullable(),
  absent_source_external_ids: z.array(activitySourceSchema).nullable().default(null),
  member_activity_ids: z.array(z.string()).optional().default([]),
  avg_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  avg_power: z.number().nullable(),
  max_power: z.number().nullable(),
  avg_speed: z.number().nullable(),
  max_speed: z.number().nullable(),
  avg_cadence: z.number().nullable(),
  total_distance: z.number().nullable(),
  elevation_gain_m: z.number().nullable(),
  elevation_loss_m: z.number().nullable(),
  sample_count: z.number().nullable(),
  provider_absent_at: timestampStringSchema.nullable().optional().default(null),
});

export const streamPointRowSchema = z.object({
  recorded_at: timestampStringSchema,
  heart_rate: z.number().nullable(),
  power: z.number().nullable(),
  speed: z.number().nullable(),
  cadence: z.number().nullable(),
  altitude: z.number().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
});

export const hrZoneRowSchema = z.object({
  zone: z.coerce.number(),
  seconds: z.coerce.number(),
});

export const powerZoneRowSchema = z.object({
  zone: z.coerce.number(),
  seconds: z.coerce.number(),
});

export const activitySensorWindowRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  member_activity_ids: z.array(z.string()),
});

export const activitySummaryReadModelRowSchema = z.object({
  activity_id: z.string(),
  avg_hr: z.number().nullable(),
  max_hr: z.number().nullable(),
  avg_power: z.number().nullable(),
  max_power: z.number().nullable(),
  avg_speed: z.number().nullable(),
  max_speed: z.number().nullable(),
  avg_cadence: z.number().nullable(),
  total_distance: z.number().nullable(),
  elevation_gain_m: z.number().nullable(),
  elevation_loss_m: z.number().nullable(),
  sample_count: z.number().nullable(),
  centroid_lat: z.number().nullable().default(null),
  centroid_lng: z.number().nullable().default(null),
});

export const activityIdResolutionSchema = z.object({
  requested_id: z.string(),
  resolved_group_id: z.string(),
  resolution_kind: z.enum(["group", "member", "alias"]),
});

export type ActivityIdResolution = z.infer<typeof activityIdResolutionSchema>;
