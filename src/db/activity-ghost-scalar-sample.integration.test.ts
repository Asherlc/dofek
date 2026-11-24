import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getGhostScalarSamples } from "./activity-ghost-scalar-sample.ts";
import { createActivitySourceRecordsSql } from "./activity-payload-dbt-source-test-helpers.ts";
import type { ClickHouseClient } from "./clickhouse.ts";
import {
  buildDedupedSensorBackfillSql,
  buildIncrementalDedupedSensorBaseTableStatements,
} from "./clickhouse-deduped-sensor.ts";

const userId = randomUUID();
const otherUserId = randomUUID();
const activityId = randomUUID();
const stravaMember = randomUUID();
const garminMember = randomUUID();
const appleMember = randomUUID();
const unrelatedMember = randomUUID();
const recordedAt = "2026-09-07T10:05:00.123456Z";
const window = {
  userId,
  activityId,
  memberActivityIds: [stravaMember, garminMember, appleMember],
  startedAt: "2026-09-07T10:00:00.000000Z",
  endedAt: "2026-09-07T10:10:00.000000Z",
};

function sample(
  overrides: {
    provider_id?: string;
    activity_id?: string | null;
    member_activity_id?: string | null;
    user_id?: string;
    recorded_at?: string;
    channel?: string;
    scalar?: number;
    provider_priority?: number;
    measurement_kind?: string;
    device_id?: string | null;
    source_type?: string;
  } = {},
) {
  const { activity_id: member = garminMember, ...fields } = overrides;
  return {
    id: randomUUID(),
    user_id: userId,
    activity_id: member,
    member_activity_id: member,
    provider_id: "garmin",
    device_id: "Edge 1040",
    source_type: "api",
    recorded_date: "2026-09-07",
    recorded_at: "2026-09-07 10:05:00.123456",
    channel: "heart_rate",
    scalar: 132,
    provider_priority: 20,
    _peerdb_is_deleted: 0,
    _peerdb_version: 1,
    ...fields,
  };
}

function sourceRecord(
  memberId: string,
  providerId: string | null,
  options: {
    group_id?: string | null;
    user_id?: string | null;
    canonical_type?: string | null;
    modality?: string | null;
    source_name?: string;
    raw?: string;
    refresh_version?: number;
    is_deleted?: number;
  } = {},
) {
  return {
    activity_id: memberId,
    group_id: activityId,
    provider_id: providerId,
    user_id: userId,
    canonical_type: "cycling",
    modality: "road",
    refresh_version: 1,
    ...options,
  };
}

describe("Ghost Sessions scalar evidence", () => {
  const database = `ghost_scalar_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;
  const scope = (query: string) => query.replaceAll("analytics.", `${database}.`);
  const queryClient: Pick<ClickHouseClient, "query"> = {
    query: (options) => client.query({ ...options, query: scope(options.query) }),
  };
  const insertSamples = (values: ReturnType<typeof sample>[]) =>
    client.insert({ table: `${database}.sensor_scalar_sample`, format: "JSONEachRow", values });
  const insertSources = (values: ReturnType<typeof sourceRecord>[]) =>
    client.insert({ table: `${database}.activity_source_records`, format: "JSONEachRow", values });

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) throw new Error("CLICKHOUSE_URL is required for Ghost Sessions scalar tests");
    client = createClient({ url });
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const query of buildIncrementalDedupedSensorBaseTableStatements()) {
      await client.command({ query: scope(query) });
    }
    await client.command({ query: createActivitySourceRecordsSql(database) });
  });

  beforeEach(async () => {
    for (const table of ["sensor_scalar_sample", "deduped_sensor", "activity_source_records"]) {
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
    }
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("selects Garmin at the original precision when ordinary deduplication picks Strava", async () => {
    const garmin = sample();
    const strava = sample({
      activity_id: stravaMember,
      provider_id: "strava",
      device_id: null,
      provider_priority: 1,
      scalar: 181,
    });
    await insertSources([
      sourceRecord(stravaMember, "strava"),
      sourceRecord(garminMember, "garmin"),
    ]);
    await insertSamples([strava, garmin]);

    await client.command({ query: scope(buildDedupedSensorBackfillSql()) });
    const ordinary = await queryClient.query({
      query: "SELECT provider_id, scalar FROM analytics.deduped_sensor FINAL WHERE is_deleted = 0",
      format: "JSONEachRow",
    });
    expect(await ordinary.json()).toEqual([{ provider_id: "strava", scalar: 181 }]);

    const rows = await getGhostScalarSamples(queryClient, window);
    expect(rows).toEqual([
      expect.objectContaining({
        id: garmin.id,
        channel: "heart_rate",
        recorded_at: recordedAt,
        scalar: 132,
        provider_id: "garmin",
        device_id: "Edge 1040",
        source_id: '["garmin","Edge 1040"]',
        member_activity_id: garminMember,
      }),
    ]);
  });

  it.each([
    { source_name: " STRAVA ", raw: "{}" },
    { source_name: "An imported ride", raw: '{"sourceBundle":" COM.STRAVA.STRAVA "}' },
  ])("excludes an Apple Health copy identified by %j", async (origin) => {
    const garmin = sample();
    await insertSources([
      sourceRecord(garminMember, "garmin"),
      sourceRecord(appleMember, "apple_health", origin),
    ]);
    await insertSamples([
      garmin,
      sample({
        activity_id: appleMember,
        provider_id: "apple_health",
        device_id: "Watch",
        provider_priority: 1,
        scalar: 181,
      }),
    ]);
    expect(await getGhostScalarSamples(queryClient, window)).toEqual([
      expect.objectContaining({ id: garmin.id, scalar: 132 }),
    ]);
  });

  it("fences the same source ID by owner, canonical group, verified members and selected interval", async () => {
    const garmin = sample();
    await insertSources([
      sourceRecord(garminMember, "garmin"),
      sourceRecord(unrelatedMember, "garmin", { group_id: randomUUID() }),
      sourceRecord(appleMember, "garmin", { user_id: otherUserId }),
    ]);
    const preferred = { provider_priority: 1, scalar: 181 };
    await insertSamples([
      garmin,
      sample({ ...preferred, user_id: otherUserId }),
      sample({ ...preferred, activity_id: unrelatedMember }),
      sample({ ...preferred, activity_id: appleMember }),
      sample({ ...preferred, recorded_at: "2026-09-07 10:10:00.000001" }),
      sample({ ...preferred, recorded_at: "2026-09-07 09:59:59.999999" }),
    ]);

    expect(
      await getGhostScalarSamples(queryClient, {
        ...window,
        memberActivityIds: [...window.memberActivityIds, unrelatedMember],
      }),
    ).toEqual([expect.objectContaining({ id: garmin.id, scalar: 132 })]);
  });

  it("clears sample tombstones and removes stale samples when the member is removed", async () => {
    const garmin = sample();
    const speed = sample({ channel: "speed", scalar: 0 });
    await insertSources([
      sourceRecord(stravaMember, "strava"),
      sourceRecord(garminMember, "garmin"),
    ]);
    await insertSamples([garmin, speed]);
    expect(await getGhostScalarSamples(queryClient, window)).toHaveLength(2);

    await insertSamples([{ ...garmin, _peerdb_is_deleted: 1, _peerdb_version: 2 }]);
    expect(await getGhostScalarSamples(queryClient, window)).toEqual([
      expect.objectContaining({ id: speed.id, scalar: 0 }),
    ]);
    await insertSources([
      sourceRecord(garminMember, null, {
        group_id: null,
        user_id: null,
        canonical_type: null,
        modality: null,
        refresh_version: 2,
        is_deleted: 1,
      }),
    ]);
    await insertSamples([
      sample({ activity_id: stravaMember, provider_id: "strava", scalar: 181 }),
    ]);
    expect(await getGhostScalarSamples(queryClient, window)).toEqual([]);
  });

  it("places identifiable direct standalone observations and restricts output to four channels", async () => {
    const strap = sample({
      activity_id: null,
      provider_id: "ble_heart_rate",
      source_type: "ble",
      device_id: "strap-1",
    });
    const power = sample({ channel: "power", scalar: 0 });
    const speed = sample({ channel: "speed", scalar: 0 });
    const altitude = sample({ channel: "altitude", scalar: -12 });
    await insertSources([sourceRecord(garminMember, "garmin")]);
    await insertSamples([
      strap,
      sample({
        activity_id: null,
        provider_id: "ble_heart_rate",
        source_type: "ble",
        device_id: null,
        scalar: 181,
        provider_priority: 1,
      }),
      sample({
        activity_id: null,
        provider_id: "apple_health",
        device_id: "Watch",
        scalar: 181,
        provider_priority: 1,
      }),
      sample({
        member_activity_id: appleMember,
        activity_id: null,
        provider_id: "ble_heart_rate",
        source_type: "ble",
        device_id: "strap-1",
        scalar: 181,
        provider_priority: 1,
      }),
      power,
      speed,
      altitude,
      sample({ channel: "cadence" }),
    ]);
    expect(await getGhostScalarSamples(queryClient, window)).toEqual([
      expect.objectContaining({ id: altitude.id, scalar: -12 }),
      expect.objectContaining({ id: strap.id, member_activity_id: null }),
      expect.objectContaining({ id: power.id, scalar: 0 }),
      expect.objectContaining({ id: speed.id, scalar: 0 }),
    ]);
    expect(await getGhostScalarSamples(queryClient, { ...window, memberActivityIds: [] })).toEqual(
      [],
    );
  });
});
