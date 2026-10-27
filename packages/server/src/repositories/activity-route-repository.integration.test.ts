import { randomUUID } from "node:crypto";
import { createClickHouseClientFromEnv } from "dofek/db/clickhouse";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ActivitySensorStore, ActivitySensorWindow } from "./activity-repository.ts";
import { getActivityRoute } from "./activity-route-repository.ts";

const userId = "11111111-1111-1111-1111-111111111111";
const activityId = "22222222-2222-2222-2222-222222222222";
const memberActivityId = "33333333-3333-3333-3333-333333333333";
const window: ActivitySensorWindow = {
  userId,
  activityId,
  memberActivityIds: [memberActivityId],
  startedAt: "2026-07-01T12:00:00.000Z",
  endedAt: "2026-07-01T13:00:00.000Z",
};

describe("getActivityRoute", () => {
  const database = `activity_route_test_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const sensorStore: Pick<ActivitySensorStore, "query"> = {
    async query(schema, query, params) {
      const result = await client.query({
        query: query.replaceAll("analytics.", `${database}.`),
        format: "JSONEachRow",
        query_params: params,
      });
      return z.array(schema).parse(await result.json());
    },
  };

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.activity_location_member_change (
        member_activity_id UUID,
        user_id UUID,
        changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC')),
        has_live_sample SimpleAggregateFunction(max, UInt8)
      ) ENGINE = AggregatingMergeTree ORDER BY (user_id, member_activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_location_sample (
        activity_id UUID,
        user_id UUID,
        recorded_at DateTime64(9, 'UTC'),
        source_metric_stream_id UUID,
        lat Nullable(Float64),
        lng Nullable(Float64),
        refresh_version UInt64,
        is_deleted UInt8,
        source_refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
        ORDER BY (user_id, activity_id, source_metric_stream_id)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_member_change
        (member_activity_id, user_id, changed_at, has_live_sample)
       VALUES (
        toUUID('${memberActivityId}'), toUUID('${userId}'),
        toDateTime64('2026-07-01 12:30:00', 9, 'UTC'), 1
       )`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample (
        activity_id, user_id, recorded_at, source_metric_stream_id,
        lat, lng, refresh_version, is_deleted, source_refreshed_at
      ) VALUES (
        toUUID('${activityId}'), toUUID('${userId}'),
        toDateTime64('2026-07-01 12:01:00', 9, 'UTC'),
        toUUID('44444444-4444-4444-4444-444444444444'),
        37.1, -122.1, 1, 0,
        toDateTime64('2026-07-01 12:10:00', 9, 'UTC')
      )`,
    });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  it("returns processing without partial GPS points while the read model trails ingestion", async () => {
    await expect(getActivityRoute(sensorStore, window, 500)).resolves.toEqual({
      status: "processing",
    });
  });

  it("returns the full route with both endpoints after the read model catches up", async () => {
    const readyActivityId = "55555555-5555-5555-5555-555555555555";
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample (
        activity_id, user_id, recorded_at, source_metric_stream_id,
        lat, lng, refresh_version, is_deleted, source_refreshed_at
      ) VALUES
      (
        toUUID('${readyActivityId}'), toUUID('${userId}'),
        toDateTime64('2026-07-01 12:00:00', 9, 'UTC'),
        toUUID('66666666-6666-6666-6666-666666666666'),
        37.1, -122.1, 2, 0, toDateTime64('2026-07-01 12:31:00', 9, 'UTC')
      ),
      (
        toUUID('${readyActivityId}'), toUUID('${userId}'),
        toDateTime64('2026-07-01 12:30:00', 9, 'UTC'),
        toUUID('77777777-7777-7777-7777-777777777777'),
        37.5, -122.5, 2, 0, toDateTime64('2026-07-01 12:31:00', 9, 'UTC')
      ),
      (
        toUUID('${readyActivityId}'), toUUID('${userId}'),
        toDateTime64('2026-07-01 12:59:00', 9, 'UTC'),
        toUUID('88888888-8888-8888-8888-888888888888'),
        37.9, -122.9, 2, 0, toDateTime64('2026-07-01 12:31:00', 9, 'UTC')
      )`,
    });

    await expect(
      getActivityRoute(sensorStore, { ...window, activityId: readyActivityId }, 2),
    ).resolves.toEqual({
      status: "ready",
      points: [
        { lat: 37.1, lng: -122.1 },
        { lat: 37.9, lng: -122.9 },
      ],
    });
  });

  it("reports no route for an activity without GPS", async () => {
    await expect(
      getActivityRoute(
        sensorStore,
        {
          ...window,
          activityId: "99999999-9999-9999-9999-999999999999",
          memberActivityIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
        },
        500,
      ),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("does not show route points removed during an activity group change", async () => {
    const oldActivityId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const sourceId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample (
        activity_id, user_id, recorded_at, source_metric_stream_id,
        lat, lng, refresh_version, is_deleted, source_refreshed_at
      ) VALUES
      (
        toUUID('${oldActivityId}'), toUUID('${userId}'),
        toDateTime64('2026-07-01 12:01:00', 9, 'UTC'), toUUID('${sourceId}'),
        37.1, -122.1, 1, 0, toDateTime64('2026-07-01 12:10:00', 9, 'UTC')
      ),
      (
        toUUID('${oldActivityId}'), toUUID('${userId}'),
        toDateTime64('2026-07-01 12:01:00', 9, 'UTC'), toUUID('${sourceId}'),
        37.1, -122.1, 2, 1, toDateTime64('2026-07-01 12:31:00', 9, 'UTC')
      )`,
    });

    await expect(
      getActivityRoute(sensorStore, { ...window, activityId: oldActivityId }, 500),
    ).resolves.toEqual({ status: "unavailable" });
  });
});
