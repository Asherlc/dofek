import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const activityId = "00000000-0000-4000-8000-000000000101";

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
  routeDistanceMeters: z.coerce.number().nullable(),
  coveragePct: z.coerce.number().nullable(),
  largestGapSeconds: z.coerce.number().nullable(),
  sourceProviders: z.array(z.string()),
  sourceDevices: z.array(z.string()),
  geometryStatus: z.enum(["available", "partial", "unavailable"]),
  isDeleted: z.coerce.number().int(),
});

describe("activity route identity read model", () => {
  const database = `activity_route_identity_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url) throw new Error("CLICKHOUSE_URL is required for activity route identity tests");
    client = createClient({ url, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    await seedSchema(client, database);
  }, 120_000);

  beforeEach(async () => {
    for (const table of [
      "deduped_activities",
      "activity_location_sample",
      "activity_effort_identity",
      "activity_route_identity",
    ]) {
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
    }
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("keeps an explicit provider route ID separate from normalized geometry", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "ridewithgps", routeId: "rw-42" });

    await buildModel(client, database);

    expect(await readRouteIdentity(client, database)).toEqual(
      expect.objectContaining({
        canonicalActivityId: activityId,
        explicitProviderRouteIds: [
          {
            provider: "ridewithgps",
            value: "rw-42",
            sourceActivityId: activityId,
            field: "routeId",
          },
        ],
        direction: "forward",
        pointCount: 4,
        routeDistanceMeters: expect.any(Number),
        coveragePct: 100,
        largestGapSeconds: 10,
        sourceProviders: ["ridewithgps"],
        sourceDevices: ["head-unit"],
        geometryStatus: "available",
        isDeleted: 0,
      }),
    );
  });

  it("materializes direction-preserving and reverse bounded fingerprints", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "strava", routeId: null, pointCount: 80 });

    await buildModel(client, database);

    const row = await readRouteIdentity(client, database);
    expect(row).toEqual(
      expect.objectContaining({
        explicitProviderRouteIds: [],
        pointCount: 64,
        routeFingerprint: expect.any(String),
        reverseRouteFingerprint: expect.any(String),
        geometryStatus: "available",
      }),
    );
    expect(row.routeFingerprint).not.toBe(row.reverseRouteFingerprint);
  });

  it("tombstones a current route when its deduplicated geometry disappears", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "ridewithgps", routeId: "rw-42" });
    await buildModel(client, database);
    const deletedPoints = Array.from({ length: 4 }, (_, index) => {
      const pointId = `00000000-0000-4000-8000-${String(201 + index).padStart(12, "0")}`;
      return `('${activityId}', '${userId}',
        addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), ${index * 10}), '${pointId}',
        'ridewithgps', 'head-unit', NULL, NULL, toDateTime64('2026-09-01 12:10:00', 9, 'UTC'),
        2, 1, toDateTime64('2026-09-01 12:10:00', 9, 'UTC'))`;
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
        (activity_id, user_id, recorded_at, source_metric_stream_id, provider_id, device_id, lat, lng,
         source_refreshed_at, refresh_version, is_deleted, refreshed_at)
        VALUES ${deletedPoints.join(",")}`,
    });

    await buildModel(client, database, true);

    expect(await readRouteIdentity(client, database)).toEqual(
      expect.objectContaining({ isDeleted: 1 }),
    );
  });
});

function renderModel(database: string, incremental: boolean): string {
  return renderDbtModelSql(readModelSql("activity_route_identity.sql"), { isIncremental: incremental })
    .replaceAll("{{ ref('deduped_activities') }}", `${database}.deduped_activities`)
    .replaceAll("{{ ref('activity_location_sample') }}", `${database}.activity_location_sample`)
    .replaceAll("{{ ref('activity_effort_identity') }}", `${database}.activity_effort_identity`)
    .replaceAll("{{ this }}", `${database}.activity_route_identity`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}

async function buildModel(
  client: ReturnType<typeof createClient>,
  database: string,
  incremental = false,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${database}.activity_route_identity ${renderModel(database, incremental)}`,
  });
}

async function readRouteIdentity(
  client: ReturnType<typeof createClient>,
  database: string,
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
        route_distance_meters AS routeDistanceMeters,
        coverage_pct AS coveragePct,
        largest_gap_seconds AS largestGapSeconds,
        source_providers AS sourceProviders,
        source_devices AS sourceDevices,
        geometry_status AS geometryStatus,
        is_deleted AS isDeleted
      FROM ${database}.activity_route_identity FINAL
      WHERE activity_id = '${activityId}'`,
    format: "JSONEachRow",
  });
  return routeIdentitySchema.parse((await result.json<unknown>())[0]);
}

async function seedRouteIdentityFixture(
  client: ReturnType<typeof createClient>,
  database: string,
  input: { provider: string; routeId: string | null; pointCount?: number },
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${database}.deduped_activities
      (activity_id, user_id, canonical_type, started_at, ended_at, refresh_version, is_deleted, refreshed_at)
      VALUES ('${activityId}', '${userId}', 'cycling', toDateTime64('2026-09-01 12:00:00', 6, 'UTC'),
        toDateTime64('2026-09-01 12:15:00', 6, 'UTC'), 1, 0, toDateTime64('2026-09-01 12:00:00', 9, 'UTC'))`,
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
  const points = Array.from({ length: input.pointCount ?? 4 }, (_, index) => {
    const pointId = `00000000-0000-4000-8000-${String(201 + index).padStart(12, "0")}`;
    return `('${activityId}', '${userId}',
      addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), ${index * 10}), '${pointId}',
      '${input.provider}', 'head-unit', ${37.7749 + index * 0.0001}, ${-122.4194 + index * 0.0001},
      toDateTime64('2026-09-01 12:00:00', 9, 'UTC'), 1, 0,
      toDateTime64('2026-09-01 12:00:00', 9, 'UTC'))`;
  });
  await client.command({
    query: `INSERT INTO ${database}.activity_location_sample
      (activity_id, user_id, recorded_at, source_metric_stream_id, provider_id, device_id, lat, lng,
       source_refreshed_at, refresh_version, is_deleted, refreshed_at)
      VALUES ${points.join(",")}`,
  });
}

async function seedSchema(client: ReturnType<typeof createClient>, database: string): Promise<void> {
  const statements = [
    `CREATE DATABASE ${database}`,
    `CREATE TABLE ${database}.deduped_activities (
      activity_id UUID, user_id UUID, canonical_type String, started_at DateTime64(6, 'UTC'),
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
