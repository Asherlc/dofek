import type { createClient } from "@clickhouse/client";
import { z } from "zod";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

export const userId = "00000000-0000-4000-8000-000000000001";
export const activityId = "00000000-0000-4000-8000-000000000101";
export const secondActivityId = "00000000-0000-4000-8000-000000000102";
export const memberId = "00000000-0000-4000-8000-000000000103";
export const otherUserId = "00000000-0000-4000-8000-000000000002";

const routeIdentitySchema = z.object({
  canonicalActivityId: z.string().uuid(),
  explicitProviderRouteIds: z.array(
    z.object({
      provider: z.string(),
      value: z.string(),
      sourceActivityId: z.string().uuid(),
      field: z.string(),
    }),
  ),
  routeFingerprint: z.string().nullable(),
  reverseRouteFingerprint: z.string().nullable(),
  direction: z.enum(["forward", "reverse", "unknown"]),
  pointCount: z.coerce.number().int(),
  points: z.array(z.object({ lat: z.number(), lng: z.number() })),
  elevationProfile: z.array(z.number()),
  routeDistanceMeters: z.coerce.number().nullable(),
  coveragePct: z.coerce.number().nullable(),
  largestGapSeconds: z.coerce.number().nullable(),
  sourceProviders: z.array(z.string()),
  sourceDevices: z.array(z.string()),
  geometryStatus: z.enum(["available", "partial", "unavailable"]),
  isDeleted: z.coerce.number().int(),
});

export function renderModel(
  database: string,
  incremental: boolean,
  scopedIds?: readonly string[],
): string {
  return renderDbtModelSql(readModelSql("activity_route_identity.sql"), {
    isIncremental: incremental,
    activityRefreshScoped: scopedIds !== undefined,
  })
    .replaceAll("{{ ref('deduped_activities') }}", `${database}.deduped_activities`)
    .replaceAll("{{ ref('activity_location_sample') }}", `${database}.activity_location_sample`)
    .replaceAll("{{ ref('activity_effort_identity') }}", `${database}.activity_effort_identity`)
    .replaceAll("{{ ref('activity_sensor_sample') }}", `${database}.activity_sensor_sample`)
    .replaceAll("{{ this }}", `${database}.activity_route_identity`)
    .replaceAll('{{ var("activity_refresh_user_id") }}', userId)
    .replaceAll(
      "{{ activity_refresh_ids() }}",
      `[${(scopedIds ?? []).map((id) => `toUUID('${id}')`).join(",")}]`,
    )
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1, enable_materialized_cte = 1");
}

export async function buildModel(
  client: ReturnType<typeof createClient>,
  database: string,
  incremental = false,
  scopedIds?: readonly string[],
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${database}.activity_route_identity ${renderModel(database, incremental, scopedIds)}`,
  });
}

export async function readRouteIdentity(
  client: ReturnType<typeof createClient>,
  database: string,
  selectedActivityId = activityId,
): Promise<z.infer<typeof routeIdentitySchema>> {
  const result = await client.query({
    query: `SELECT
        toString(canonical_activity_id) AS canonicalActivityId,
        arrayMap(route -> map(
          'provider', route.1,
          'value', route.2,
          'sourceActivityId', toString(route.3),
          'field', route.4
        ), explicit_provider_route_ids) AS explicitProviderRouteIds,
        route_fingerprint AS routeFingerprint,
        reverse_route_fingerprint AS reverseRouteFingerprint,
        direction,
        point_count AS pointCount,
        points,
        elevation_profile AS elevationProfile,
        route_distance_meters AS routeDistanceMeters,
        coverage_pct AS coveragePct,
        largest_gap_seconds AS largestGapSeconds,
        source_providers AS sourceProviders,
        source_devices AS sourceDevices,
        geometry_status AS geometryStatus,
        is_deleted AS isDeleted
      FROM ${database}.activity_route_identity FINAL
      WHERE activity_id = '${selectedActivityId}' AND user_id = '${userId}'`,
    format: "JSONEachRow",
  });
  return routeIdentitySchema.parse((await result.json<unknown>())[0]);
}

export async function seedRouteIdentityFixture(
  client: ReturnType<typeof createClient>,
  database: string,
  input: {
    provider: string;
    routeId: string | null;
    pointCount?: number;
    activityId?: string;
    userId?: string;
    memberIds?: string[];
    points?: readonly { lat: number; lng: number }[];
    seconds?: number[];
    durationSeconds?: number;
  },
): Promise<void> {
  const activityId = input.activityId ?? "00000000-0000-4000-8000-000000000101";
  const userId = input.userId ?? "00000000-0000-4000-8000-000000000001";
  await client.command({
    query: `INSERT INTO ${database}.deduped_activities
      (activity_id, user_id, member_activity_ids, canonical_type, started_at, ended_at, refresh_version, is_deleted, refreshed_at)
      VALUES ('${activityId}', '${userId}', [${(input.memberIds ?? [activityId]).map((id) => `'${id}'`).join(",")}], 'cycling', toDateTime64('2026-09-01 12:00:00', 6, 'UTC'),
        addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), ${input.durationSeconds ?? input.seconds?.at(-1) ?? ((input.points?.length ?? input.pointCount ?? 4) - 1) * 10}), 1, 0, toDateTime64('2026-09-01 12:00:00', 9, 'UTC'))`,
  });
  if (input.routeId !== null) {
    await client.command({
      query: `INSERT INTO ${database}.activity_effort_identity
        (user_id, canonical_activity_id, source_activity_id, source_provider, kind, value, source_field,
         source_refreshed_at, refresh_version, is_deleted, refreshed_at)
        VALUES ('${userId}', '${activityId}', '${activityId}', '${input.provider}', 'provider_route',
          '${input.routeId}', 'routeId', toDateTime64('2026-09-01 12:00:00', 9, 'UTC'), 1, 0,
          toDateTime64('2026-09-01 12:00:00', 9, 'UTC'))`,
    });
  }
  const points = Array.from(
    { length: input.points?.length ?? input.pointCount ?? 4 },
    (_, index) => {
      const pointId = `00000000-0000-4000-8000-${String(201 + index).padStart(12, "0")}`;
      return `('${activityId}', '${userId}',
      addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), ${input.seconds?.[index] ?? index * 10}), '${pointId}',
      '${input.provider}', 'head-unit', ${input.points?.[index]?.lat ?? 37.7749 + index * 0.0001}, ${input.points?.[index]?.lng ?? -122.4194 + index * 0.0001},
      toDateTime64('2026-09-01 12:00:00', 9, 'UTC'), 1, 0,
      toDateTime64('2026-09-01 12:00:00', 9, 'UTC'))`;
    },
  );
  await client.command({
    query: `INSERT INTO ${database}.activity_location_sample
      (activity_id, user_id, recorded_at, source_metric_stream_id, provider_id, device_id, lat, lng,
       source_refreshed_at, refresh_version, is_deleted, refreshed_at)
      VALUES ${points.join(",")}`,
  });
}

export async function seedSchema(
  client: ReturnType<typeof createClient>,
  database: string,
): Promise<void> {
  const statements = [
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.activity_sensor_sample (
      activity_id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'), channel String,
      scalar Nullable(Float64), is_deleted UInt8, refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refreshed_at) ORDER BY (user_id, activity_id, channel, recorded_at)`,
    `CREATE TABLE ${database}.deduped_activities (
      activity_id UUID, user_id UUID, member_activity_ids Array(UUID), canonical_type String, started_at DateTime64(6, 'UTC'),
      ended_at Nullable(DateTime64(6, 'UTC')), refresh_version UInt64, is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    `CREATE TABLE ${database}.activity_location_sample (
      activity_id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'), source_metric_stream_id UUID,
      provider_id String, device_id Nullable(String), lat Nullable(Float64), lng Nullable(Float64),
      source_refreshed_at DateTime64(9, 'UTC'), refresh_version UInt64, is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, recorded_at, source_metric_stream_id)`,
    `CREATE TABLE ${database}.activity_effort_identity (
      user_id UUID, canonical_activity_id UUID, source_activity_id UUID, source_provider String,
      kind String, value String, source_field String, source_refreshed_at DateTime64(9, 'UTC'),
      refresh_version UInt64, is_deleted UInt8, refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, source_activity_id, kind, value, source_field)`,
    `CREATE TABLE ${database}.activity_route_identity (
      activity_id UUID, user_id UUID, canonical_activity_id UUID,
      explicit_provider_route_ids Array(Tuple(provider String, value String, source_activity_id UUID, field String)),
      route_fingerprint Nullable(String), reverse_route_fingerprint Nullable(String), direction String,
      points Array(Tuple(lat Float64, lng Float64)), point_count UInt64,
      route_distance_meters Nullable(Float64), started_at Nullable(DateTime64(6, 'UTC')),
      ended_at Nullable(DateTime64(6, 'UTC')), elevation_profile Array(Float64), coverage_pct Nullable(Float64),
      largest_gap_seconds Nullable(Float64), source_providers Array(String), source_devices Array(String),
      geometry_status String, source_refreshed_at DateTime64(9, 'UTC'), refresh_version UInt64,
      is_deleted UInt8, refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
  ];
  for (const query of statements) await client.command({ query });
}
