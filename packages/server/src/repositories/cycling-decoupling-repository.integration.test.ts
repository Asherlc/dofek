import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { ChartRange } from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CyclingDecouplingRepository } from "./cycling-decoupling-repository.ts";

describe("CyclingDecouplingRepository", () => {
  const database = `cycling_decoupling_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const userId = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  const estimated = randomUUID();
  const linkedEstimate = randomUUID();
  const linkedUnusedEstimate = randomUUID();
  const sparse = randomUUID();
  const outside = randomUUID();
  const deleted = randomUUID();
  const otherUser = randomUUID();
  const unlinked = randomUUID();
  const staleIdentity = randomUUID();
  const foreignRide = randomUUID();
  const start = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const query = (statement: string) =>
    client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
  const store: Pick<ActivitySensorStore, "query"> = {
    async query<TSchema extends z.ZodType>(
      schema: TSchema,
      statement: string,
      params?: Record<string, unknown>,
    ) {
      const result = await client.query({
        query: statement.replaceAll("analytics.", `${database}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };

  beforeAll(async () => {
    await query(`CREATE DATABASE ${database}`);
    await query(`CREATE TABLE analytics.deduped_activities (
      user_id UUID, activity_id UUID, started_at DateTime64(6), ended_at Nullable(DateTime64(6)),
      canonical_type String, modality Nullable(String), name Nullable(String), local_time_source String,
      start_utc_offset_minutes Nullable(Int16), member_activity_ids Array(UUID), is_deleted UInt8
    ) ENGINE = ReplacingMergeTree ORDER BY (user_id, activity_id)`);
    await query(`CREATE TABLE analytics.activity_effort_identity (
      user_id UUID, canonical_activity_id UUID, source_activity_id UUID, kind String, namespace String,
      value String, strength String, is_deleted UInt8
    ) ENGINE = ReplacingMergeTree ORDER BY (user_id, source_activity_id, kind, namespace, value)`);
    await query(`CREATE TABLE analytics.activity_source_records (
      user_id UUID, activity_id UUID, provider_id String, raw Nullable(String), is_deleted UInt8
    ) ENGINE = ReplacingMergeTree ORDER BY (user_id, activity_id)`);
    await query(`CREATE TABLE analytics.activity_sensor_sample (
      user_id UUID, activity_id UUID, recorded_at DateTime64(6), channel String, scalar Nullable(Float64),
      measurement_kind String, provider_id Nullable(String), member_activity_id Nullable(UUID), is_deleted UInt8
    ) ENGINE = ReplacingMergeTree ORDER BY (user_id, activity_id, channel, recorded_at)`);
    for (const [index, id] of [
      first,
      second,
      estimated,
      linkedEstimate,
      sparse,
      outside,
      deleted,
      unlinked,
      staleIdentity,
      foreignRide,
    ].entries()) {
      const date = id === outside ? "2000-01-01" : start;
      const timestamp = `${date} ${String(index + 7).padStart(2, "0")}:00:00`;
      const owner = id === foreignRide ? otherUser : userId;
      await query(`INSERT INTO analytics.deduped_activities
        SELECT '${owner}', '${id}', toDateTime64('${timestamp}', 6),
          addMinutes(toDateTime64('${timestamp}', 6), 20), 'cycling', 'indoor', 'Tempo', '', NULL, ${id === second ? `['${id}', '${linkedUnusedEstimate}']` : `['${id}']`}, ${id === deleted ? 1 : 0}`);
      await query(`INSERT INTO analytics.activity_effort_identity VALUES
        ('${owner}', '${id}', '${id === staleIdentity ? randomUUID() : id}', 'provider_workout', 'peloton', '${id === unlinked ? id : "class-1"}', 'exact', 0)`);
      const unidentifiedPower = id === first ? "number = 0" : "false";
      await query(`INSERT INTO analytics.activity_sensor_sample
        SELECT '${owner}', '${id}', addSeconds(toDateTime64('${timestamp}', 6), number % 1200),
          if(number < 1200, 'power', 'heart_rate'),
          if(number < 1200, 200, if(number < 1800, 100, 125)),
          if(${id === estimated} AND number < 1200, 'estimated',
            if(${unidentifiedPower}, 'unknown', 'direct')),
          if(${unidentifiedPower}, NULL, '${id === linkedEstimate ? "strava" : "peloton"}'),
          if(${unidentifiedPower}, NULL, toUUID('${id}')), 0
        FROM numbers(2400) WHERE number < ${id === sparse ? 1800 : 2400}`);
    }
    await query(`INSERT INTO analytics.activity_source_records VALUES
      ('${userId}', '${linkedEstimate}', 'strava', '{"device_watts":false}', 0),
      ('${userId}', '${linkedUnusedEstimate}', 'strava', '{"device_watts":false}', 0),
      ('${otherUser}', '${first}', 'strava', '{"device_watts":false}', 0)`);
  });

  afterAll(async () => {
    await query(`DROP DATABASE IF EXISTS ${database}`);
    await client.close();
  });

  it("returns an empty series when only one ride belongs to the caller", async () => {
    const repository = new CyclingDecouplingRepository(store, otherUser, "UTC");
    await expect(repository.getTrend(ChartRange.fromDays(null))).resolves.toEqual({
      workoutName: null,
      rides: [],
    });
  });

  it("applies entitlement before testing workout repetition", async () => {
    const repository = new CyclingDecouplingRepository(store, userId, "UTC", {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: tomorrow,
      endDateExclusive: "2100-01-01",
    });
    await expect(repository.getTrend(ChartRange.fromDays(null))).resolves.toEqual({
      workoutName: null,
      rides: [],
    });
  });

  it("returns paired results for two exact same-day Peloton class repeats", async () => {
    const trend = await new CyclingDecouplingRepository(store, userId, "UTC").getTrend(
      ChartRange.fromDays(30),
    );
    expect(trend.workoutName).toBe("Tempo");
    expect(trend.rides.map((ride) => ride.activityId)).toEqual([first, second]);
    expect(trend.rides[0]).toMatchObject({
      date: start,
      percent: 20,
      elapsedSeconds: 1200,
      powerMeasurementKind: "unknown",
      heartRateMeasurementKind: "direct",
      firstHalf: { pairedSeconds: 600, coveragePct: 100, meanWatts: 200, meanBpm: 100 },
      secondHalf: { pairedSeconds: 600, coveragePct: 100, meanWatts: 200, meanBpm: 125 },
    });
  });
});
