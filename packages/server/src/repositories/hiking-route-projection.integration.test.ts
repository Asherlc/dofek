import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { routeComparisonsSchema } from "@dofek/training/route-comparison";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildModel,
  seedRouteIdentityFixture,
  seedSchema,
  userId,
} from "../../../../src/db/activity-route-identity-test-helpers.ts";
import { HikingRepository } from "./hiking-repository.ts";

describe("GPS comparison with model-produced route identities", () => {
  const database = `hiking_route_projection_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url) throw new Error("CLICKHOUSE_URL is required for GPS route projection tests");
    client = createClient({ url });
    await seedSchema(client, database);
    await client.command({
      query: `CREATE TABLE ${database}.hiking_activity (
        activity_id UUID, user_id UUID, canonical_type String, activity_name Nullable(String),
        started_at DateTime64(6, 'UTC'), distance_m Float64, duration_seconds Float64,
        average_pace_min_per_km Float64, avg_heart_rate Nullable(Float64), elevation_gain_m Float64,
        refresh_version UInt64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
  });

  beforeEach(async () => {
    for (const table of [
      "hiking_activity",
      "deduped_activities",
      "activity_location_sample",
      "activity_effort_identity",
      "activity_route_identity",
      "activity_sensor_sample",
    ]) {
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
    }
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("serves matching walking, hiking and trail-running attempts from the actual route projection", async () => {
    const expected = [];
    for (const [canonicalType, modality] of [
      ["walking", null],
      ["hiking", null],
      ["running", "trail"],
    ] as const) {
      const ids = [randomUUID(), randomUUID()];
      expected.push({ canonicalType, ids });
      for (const id of ids) {
        await seedRouteIdentityFixture(client, database, {
          activityId: id,
          canonicalType,
          modality,
          provider: "strava",
          routeId: null,
        });
        await client.insert({
          table: `${database}.hiking_activity`,
          values: [
            {
              activity_id: id,
              user_id: userId,
              canonical_type: canonicalType,
              activity_name: `Route ${id}`,
              started_at: "2026-09-01 12:00:00",
              distance_m: 42,
              duration_seconds: 30,
              average_pace_min_per_km: 12,
              avg_heart_rate: null,
              elevation_gain_m: 0,
              refresh_version: 1,
              is_deleted: 0,
            },
          ],
          format: "JSONEachRow",
        });
      }
    }
    await buildModel(client, database);

    const store = {
      async query<TSchema extends z.ZodType>(
        schema: TSchema,
        query: string,
        params?: Record<string, unknown>,
      ): Promise<z.infer<TSchema>[]> {
        const result = await client.query({
          query: query.replaceAll("analytics.", `${database}.`),
          query_params: params,
          format: "JSONEachRow",
        });
        return z.array(schema).parse(await result.json());
      },
    };
    const repository = new HikingRepository(
      { execute: async () => [] },
      userId,
      "America/Los_Angeles",
      store,
    );
    const comparisons = routeComparisonsSchema.parse(await repository.getRepeatedRoutes(null));
    expect(comparisons).toHaveLength(3);
    for (const { canonicalType, ids } of expected) {
      const comparison = comparisons.find((route) => route.activityType === canonicalType);
      expect(comparison?.attemptCount).toBe(2);
      expect(new Set(comparison?.instances.map((instance) => instance.activityId))).toEqual(
        new Set(ids),
      );
    }
  });
});
