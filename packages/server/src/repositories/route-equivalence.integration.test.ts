import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityId,
  buildModel,
  readRouteIdentity,
  secondActivityId,
  seedRouteIdentityFixture,
  seedSchema,
} from "../../../../src/db/activity-route-identity-test-helpers.ts";
import type { RouteGeometry } from "./repeated-effort-types.ts";
import { evaluateRouteMatch } from "./route-equivalence.ts";

describe("materialized route equivalence", () => {
  const database = `route_equivalence_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url)
      throw new Error("CLICKHOUSE_URL is required for materialized route equivalence tests");
    client = createClient({ url });
    await seedSchema(client, database);
  });

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

  it.each([
    { name: "nearby inferred geometry", offset: 0.00001, detour: false, matched: true },
    { name: "similar endpoints with a different middle", offset: 0, detour: true, matched: false },
    { name: "different geometry", offset: 1, detour: false, matched: false },
  ])("compares $name using materialized evidence", async ({ offset, detour, matched }) => {
    const points = [
      { lat: 37.77, lng: -122.42 },
      { lat: 37.78, lng: -122.42 },
      { lat: 37.79, lng: -122.42 },
      { lat: 37.8, lng: -122.42 },
    ];
    await seedRouteIdentityFixture(client, database, {
      provider: "ridewithgps",
      routeId: "rw-42",
      points,
    });
    await seedRouteIdentityFixture(client, database, {
      provider: "strava",
      routeId: null,
      activityId: secondActivityId,
      points: points.map((point, index) => ({
        lat: point.lat + offset,
        lng: point.lng + (detour && index > 0 && index < 3 ? 0.01 : 0),
      })),
      seconds: [0, 10, 20, 120],
    });
    await buildModel(client, database);
    const left = await readRouteIdentity(client, database);
    const right = await readRouteIdentity(client, database, secondActivityId);
    expect(left.canonicalActivityId).toBe(activityId);
    expect(right.canonicalActivityId).toBe(secondActivityId);
    const result = evaluateRouteMatch({
      left: geometryFromRow(left),
      right: geometryFromRow(right),
    });
    expect(result).toMatchObject({
      matched,
      elevation_similarity: null,
      left_quality: { geometry_status: "available", coverage_pct: 100, largest_gap_seconds: 10 },
      right_quality: {
        geometry_status: "available",
        coverage_pct: 100 / 6,
        largest_gap_seconds: 100,
      },
    });
    if (matched)
      expect(result).toMatchObject({
        strength: "strong_inferred",
        direction: "forward",
        rejection_reasons: [],
      });
    else expect(result?.rejection_reasons).toContain("overlap_below_threshold");
  });
});

function geometryFromRow(row: Awaited<ReturnType<typeof readRouteIdentity>>): RouteGeometry {
  return {
    points: row.points,
    distance_meters: row.routeDistanceMeters,
    elevation_profile: row.elevationProfile,
    geometry_status: row.geometryStatus,
    coverage_pct: row.coveragePct,
    largest_gap_seconds: row.largestGapSeconds,
  };
}
