import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import type { AccessWindow } from "../billing/entitlement.ts";
import { ChartRange } from "../lib/chart-range.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CyclingDurabilityRepository } from "./cycling-durability-repository.ts";

const userId = randomUUID();
const otherUserId = randomUUID();
const heavyRide = randomUUID();
const lightRide = randomUUID();
const estimatedWeightRide = randomUUID();
const remoteRide = randomUUID();
const indoorRide = randomUUID();
const foreignRide = randomUUID();
const futureRide = randomUUID();
const runningRide = randomUUID();
const offsetRide = randomUUID();
const sameWeightRide = randomUUID();
const closeWeightRide = randomUUID();
const interpolatedRide = randomUUID();
const timezone = "America/Los_Angeles";
const database = `cycling_durability_${randomUUID().replaceAll("-", "")}`;

describe("CyclingDurabilityRepository on ClickHouse", () => {
  const client = createClickHouseClientFromEnv();
  const store: Pick<ActivitySensorStore, "query"> = {
    async query<TSchema extends z.ZodType>(
      schema: TSchema,
      query: string,
      params?: Record<string, unknown>,
    ) {
      const result = await client.query({
        query: query.replaceAll("analytics.", `${database}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await Promise.all([
      client.command({
        query: `CREATE TABLE ${database}.deduped_activities (
          activity_id UUID, user_id UUID, name Nullable(String), modality Nullable(String),
          canonical_type String, started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
          local_time_source String, start_utc_offset_minutes Nullable(Int16), is_deleted UInt8,
          refresh_version UInt64
        ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
      }),
      client.command({
        query: `CREATE TABLE ${database}.cycling_durability_effort (
          activity_id UUID, user_id UUID, started_at Nullable(DateTime64(6, 'UTC')),
          duration_seconds UInt16, is_deleted UInt8, refresh_version UInt64,
          candidates Array(Tuple(
            start_offset_seconds Float64, end_offset_seconds Float64, avg_power Float64,
            prior_joules Float64, source_member_id String, provider_id String,
            source_external_id Nullable(String), device_id Nullable(String), measurement_kind String,
            power_provenance String, observed_samples UInt64, median_sample_interval_seconds Float64,
            prefix_and_effort_largest_gap_seconds Float64, coverage_pct Float64
          ))
        ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id, duration_seconds)`,
      }),
      client.command({
        query: `CREATE TABLE ${database}.v_body_measurement (
          user_id UUID, recorded_at DateTime64(6, 'UTC'), weight_kg Float64, provider_id String,
          external_id Nullable(String), version UInt64
        ) ENGINE = MergeTree ORDER BY (user_id, recorded_at, version)`,
      }),
    ]);

    const rides = [
      {
        id: heavyRide,
        timestamp: "2026-09-11 01:00:00",
        name: "Coast loop",
        early: 360,
        late: 350,
        work: 1800000,
      },
      {
        id: lightRide,
        timestamp: "2026-09-13 01:00:00",
        name: "Hill repeats",
        early: 300,
        late: 270,
        work: 600000,
        modality: "gravel",
      },
      {
        id: estimatedWeightRide,
        timestamp: "2026-09-12 01:00:00",
        name: "Steady ride",
        early: 210,
        work: 0,
      },
      { id: remoteRide, timestamp: "2026-06-11 01:00:00", name: "Older ride", early: 700, work: 0 },
      {
        id: indoorRide,
        timestamp: "2026-09-13 01:00:00",
        name: "Indoor ride",
        early: 950,
        work: 0,
        modality: "indoor",
      },
      {
        id: foreignRide,
        timestamp: "2026-09-13 01:00:00",
        name: "Other user",
        early: 950,
        work: 0,
      },
      {
        id: futureRide,
        timestamp: "2026-09-13 01:00:00",
        name: "Still in progress",
        early: 950,
        work: 0,
        endedAt: "2099-01-01 04:00:00",
      },
      {
        id: runningRide,
        timestamp: "2026-09-13 01:00:00",
        name: "Run recorded as power",
        early: 950,
        work: 0,
        canonicalType: "running",
      },
      {
        id: offsetRide,
        timestamp: "2026-09-19 23:30:00",
        name: "Late evening ride",
        early: 500,
        work: 0,
        offsetMinutes: 120,
        localTimeSource: "provider_offset",
      },
      {
        id: sameWeightRide,
        timestamp: "2026-10-10 18:00:00",
        name: "First 70 kg ride",
        early: 300,
        work: 0,
      },
      {
        id: closeWeightRide,
        timestamp: "2026-10-12 18:00:00",
        name: "Second 70 kg ride",
        early: 200,
        late: 200,
        work: 1000000,
      },
      {
        id: interpolatedRide,
        timestamp: "2026-10-20 18:00:00",
        name: "Between weigh-ins",
        early: 400,
        work: 0,
      },
    ];
    await Promise.all([
      client.insert({
        table: `${database}.deduped_activities`,
        format: "JSONEachRow",
        values: rides.map(
          ({
            id,
            timestamp,
            name,
            endedAt,
            canonicalType = "cycling",
            modality = "road",
            offsetMinutes = -420,
            localTimeSource = "device_offset",
          }) => ({
            activity_id: id,
            user_id: id === foreignRide ? otherUserId : userId,
            name,
            modality,
            canonical_type: canonicalType,
            started_at: timestamp,
            ended_at: endedAt ?? timestamp.replace("01:", "04:"),
            local_time_source: localTimeSource,
            start_utc_offset_minutes: offsetMinutes,
            is_deleted: 0,
            refresh_version: 1,
          }),
        ),
      }),
      client.insert({
        table: `${database}.cycling_durability_effort`,
        format: "JSONEachRow",
        values: rides.map(({ id, timestamp, early, late, work }) => ({
          activity_id: id,
          user_id: id === foreignRide ? otherUserId : userId,
          started_at: timestamp,
          duration_seconds: 300,
          is_deleted: 0,
          refresh_version: 1,
          candidates: [
            candidate(id, 0, early, 0),
            ...(late ? [candidate(id, 3600, late, work)] : []),
          ],
        })),
      }),
      client.insert({
        table: `${database}.v_body_measurement`,
        format: "JSONEachRow",
        values: [
          weighIn("2026-09-10 18:00:00", 90),
          weighIn("2026-09-12 18:00:00", 60),
          weighIn("2026-09-20 18:00:00", 70),
          weighIn("2026-10-10 18:00:00", 70),
          weighIn("2026-10-12 18:00:00", 70.0000001),
          weighIn("2026-10-18 18:00:00", 90),
          weighIn("2026-10-22 18:00:00", 60),
        ],
      }),
    ]);
  });

  afterAll(async () => {
    try {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    } finally {
      await client.close?.();
    }
  });

  it("ranks by weight-adjusted power, admits exact work, and discloses weight provenance", async () => {
    const result = await compare(30);
    expect(result).toMatchObject({
      status: "available",
      presentation: { unit: "watts", absoluteWorkCutoffKilojoules: null },
      baseline: { activityId: lightRide, date: "2026-09-12", watts: 300, wattsPerKg: 5 },
      afterWork: {
        activityId: lightRide,
        watts: 270,
        workKilojoules: 600,
        workKilojoulesPerKg: 10,
        weight: { kind: "measured", sources: [{ date: "2026-09-12" }] },
        power: { provenance: "direct", deviceId: null },
      },
    });
    const differentWeights = await compare(30, undefined, "2026-09-13", 20);
    expect(differentWeights).toMatchObject({
      baseline: { activityId: lightRide },
      afterWork: { activityId: heavyRide, watts: 350 },
      presentation: { unit: "w_per_kg", absoluteWorkCutoffKilojoules: null },
    });
  });

  it("honors local-day and history bounds and separates the empty outcomes", async () => {
    const limitedComparison = await compare(30, limited("2026-09-11", "2026-09-12"));
    expect(limitedComparison.status).toBe("no_eligible_power_and_weight");
    expect(limitedComparison.baseline).toBeNull();
    const noLateEffort = await compare(1, undefined, "2026-09-11", 30);
    expect(noLateEffort).toMatchObject({
      status: "no_effort_after_work",
      baseline: { activityId: estimatedWeightRide },
      afterWork: null,
    });
    expect((await compare(null, undefined, "2026-06-12")).status).toBe(
      "no_eligible_power_and_weight",
    );
  });

  it("uses the canonical local date and excludes non-current, non-cycling rides", async () => {
    const result = await compare(null, undefined, "2026-09-20");
    expect(result.range).toEqual({ startDate: null, endDate: "2026-09-20" });
    expect(result).toMatchObject({
      status: "available",
      baseline: { activityId: offsetRide, date: "2026-09-20", watts: 500 },
    });
    const restricted = await compare(null, limited("2026-09-20", "2026-09-21"), "2026-09-20");
    expect(restricted.status).toBe("no_eligible_power_and_weight");
  });

  it("uses exactly the requested number of local dates", async () => {
    const result = await compare(2, undefined, "2026-09-13", 10);
    expect(result.range).toEqual({ startDate: "2026-09-12", endDate: "2026-09-13" });
    expect(result).toMatchObject({ status: "available", baseline: { activityId: lightRide } });
    expect((await compare(1, undefined, "2026-09-13")).status).toBe("no_eligible_power_and_weight");
  });

  it("treats weights that differ only beyond six decimals as different", async () => {
    const result = await compare(3, undefined, "2026-10-12", 10);
    expect(result).toMatchObject({
      status: "available",
      baseline: { activityId: sameWeightRide, weight: { value_kg: 70 } },
      afterWork: { activityId: closeWeightRide, weight: { value_kg: 70.0000001 } },
      presentation: { unit: "w_per_kg", absoluteWorkCutoffKilojoules: null },
    });
  });

  it("keeps interpolated weight and its dated sources in the effort evidence", async () => {
    const result = await compare(2, undefined, "2026-10-20", 10);
    expect(result.baseline?.weight).toMatchObject({
      value_kg: 75,
      kind: "interpolated",
      sources: [{ date: "2026-10-18" }, { date: "2026-10-22" }],
    });
  });

  it("identifies a same-effort comparison and prefers greater prior work when power is tied", async () => {
    const result = await compare(1, undefined, "2026-10-12");
    expect(result).toMatchObject({
      status: "available",
      baseline: { activityId: closeWeightRide, elapsedStartSeconds: 3600 },
      afterWork: { activityId: closeWeightRide, elapsedStartSeconds: 3600 },
      presentation: { unit: "watts", difference: 0 },
      sameEffort: true,
    });
  });

  it("updates the comparison when a new weight changes the recorded power ranking", async () => {
    expect((await compare(30)).baseline?.activityId).toBe(lightRide);
    await client.insert({
      table: `${database}.v_body_measurement`,
      format: "JSONEachRow",
      values: [weighIn("2026-09-12 19:00:00", 95)],
    });
    expect((await compare(30)).baseline?.activityId).toBe(heavyRide);
  });

  function compare(
    days: number | null,
    access?: AccessWindow,
    endDate = "2026-09-13",
    work: 10 | 20 | 30 = 10,
  ) {
    return new CyclingDurabilityRepository(store, userId, timezone, access).getComparison(
      ChartRange.fromDays(days),
      { durationSeconds: 300, minimumWorkKilojoulesPerKg: work },
      endDate,
    );
  }
});

function limited(startDate: string, endDateExclusive: string): AccessWindow {
  return { kind: "limited", paid: false, reason: "free_recent_week", startDate, endDateExclusive };
}

function weighIn(recordedAt: string, weight: number) {
  return {
    user_id: userId,
    recorded_at: recordedAt,
    weight_kg: weight,
    provider_id: "withings",
    version: 1,
  };
}

function candidate(activityId: string, start: number, watts: number, joules: number) {
  return {
    start_offset_seconds: start,
    end_offset_seconds: start + 300,
    avg_power: watts,
    prior_joules: joules,
    source_member_id: activityId,
    provider_id: "strava",
    source_external_id: null,
    device_id: null,
    measurement_kind: "direct",
    power_provenance: "direct",
    observed_samples: 300,
    median_sample_interval_seconds: 1,
    prefix_and_effort_largest_gap_seconds: 1,
    coverage_pct: 100,
  };
}
