import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildAccountErasureFenceTableSql } from "../metric-stream/clickhouse-table.ts";
import {
  getGhostAltitudeWindow,
  getGhostScalarSamples,
  getMeasuredGhostScalarWindow,
  readGhostAltitudeWindowProof,
} from "./activity-ghost-scalar-sample.ts";
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
const altitudeWindow = {
  activityId,
  memberActivityId: garminMember,
  providerId: "garmin",
  deviceId: null,
  startedAt: window.startedAt,
  endedAt: window.endedAt,
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
  const scope = (query: string) => query.replaceAll(/(?:analytics|ingest)\./g, `${database}.`);
  const queryClient: Pick<ClickHouseClient, "query"> = {
    query: (options) => client.query({ ...options, query: scope(options.query) }),
  };
  const insertSamples = (values: ReturnType<typeof sample>[]) =>
    client.insert({ table: `${database}.sensor_scalar_sample`, format: "JSONEachRow", values });
  const insertSources = (values: ReturnType<typeof sourceRecord>[]) =>
    client.insert({ table: `${database}.activity_source_records`, format: "JSONEachRow", values });
  const altitudeProof = (selection: Parameters<typeof readGhostAltitudeWindowProof>[2]) =>
    readGhostAltitudeWindowProof(
      async (schema, query, query_params) => {
        const result = await queryClient.query({ query, query_params, format: "JSONEachRow" });
        return schema.array().parse(await result.json());
      },
      userId,
      selection,
    );

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) throw new Error("CLICKHOUSE_URL is required for Ghost Sessions scalar tests");
    client = createClient({ url });
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const query of buildIncrementalDedupedSensorBaseTableStatements()) {
      await client.command({ query: scope(query) });
    }
    await client.command({ query: createActivitySourceRecordsSql(database) });
    await client.command({ query: scope(buildAccountErasureFenceTableSql()) });
  });

  beforeEach(async () => {
    for (const table of [
      "sensor_scalar_sample",
      "deduped_sensor",
      "activity_source_records",
      "account_erasure_fence",
    ]) {
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
    }
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("attests to raw FIT altitude and invalidates that proof on replacement and deletion", async () => {
    const rawAltitude = sample({
      channel: "altitude",
      device_id: null,
      source_type: "file",
      measurement_kind: "unknown",
      scalar: -12,
    });
    const timestampMs = Date.parse(recordedAt) + 0.456;
    await insertSources([sourceRecord(garminMember, "garmin")]);
    await insertSamples([rawAltitude]);

    const selectedTrackWindow = { ...altitudeWindow, points: [{ timestampMs, lat: 0, lng: 0 }] };
    const before = await getGhostAltitudeWindow(queryClient, userId, selectedTrackWindow);
    expect(before).toEqual({
      status: "ready",
      observations: [{ timestampMs, altitudeMeters: -12 }],
      proof: { ...altitudeWindow, count: 1, digest: expect.stringMatching(/^[A-F0-9]{64}$/) },
    });
    expect(await altitudeProof(selectedTrackWindow)).toEqual(before.proof);

    const corrected = { ...rawAltitude, scalar: -9, _peerdb_version: 2 };
    await insertSamples([corrected]);
    const replacement = await getGhostAltitudeWindow(queryClient, userId, altitudeWindow);
    expect(replacement.observations).toEqual([{ timestampMs, altitudeMeters: -9 }]);
    expect(replacement.proof?.count).toBe(1);
    expect(replacement.proof?.digest).not.toBe(before.proof?.digest);
    expect(await altitudeProof(altitudeWindow)).toEqual(replacement.proof);

    await insertSamples([{ ...corrected, _peerdb_version: 3, _peerdb_is_deleted: 1 }]);
    const deleted = await getGhostAltitudeWindow(queryClient, userId, altitudeWindow);
    expect(deleted.observations).toEqual([{ timestampMs, altitudeMeters: null }]);
    expect(deleted.proof?.count).toBe(1);
    expect(deleted.proof?.digest).not.toBe(replacement.proof?.digest);
    expect(await altitudeProof(altitudeWindow)).toEqual(deleted.proof);

    await insertSamples([{ ...corrected, _peerdb_version: 4, measurement_kind: "estimated" }]);
    const estimated = await getGhostAltitudeWindow(queryClient, userId, altitudeWindow);
    expect(estimated.observations).toEqual([]);
    expect(estimated.proof?.count).toBe(0);
    expect(await altitudeProof(altitudeWindow)).toEqual(estimated.proof);
  });

  it("uses only the selected device's recorded altitude, with conflicts left as barriers", async () => {
    const selection = { ...altitudeWindow, deviceId: "Edge 1040" };
    const sibling = randomUUID();
    const direct = sample({ channel: "altitude", measurement_kind: "direct", scalar: 15 });
    await insertSources([
      sourceRecord(garminMember, "garmin"),
      sourceRecord(sibling, "garmin"),
      sourceRecord(unrelatedMember, "garmin", { group_id: randomUUID() }),
      sourceRecord(stravaMember, "strava"),
      sourceRecord(appleMember, "apple_health", { raw: '{"sourceBundle":"com.strava.strava"}' }),
    ]);
    await insertSamples([direct]);
    const before = await getGhostAltitudeWindow(queryClient, userId, selection);
    expect(before.observations).toEqual([
      { timestampMs: Date.parse(recordedAt) + 0.456, altitudeMeters: 15 },
    ]);
    const competing = { channel: "altitude", measurement_kind: "direct", scalar: 750 };
    await insertSamples([
      sample({ ...competing, device_id: "Other bike computer" }),
      sample({ ...competing, device_id: null }),
      sample({ ...competing, measurement_kind: "estimated" }),
      sample({ ...competing, activity_id: sibling }),
      sample({ ...competing, activity_id: unrelatedMember }),
      sample({ ...competing, user_id: otherUserId }),
      sample({ ...competing, provider_id: "other_provider" }),
      sample({ ...competing, member_activity_id: sibling }),
      sample({ ...competing, activity_id: null, source_type: "ble" }),
      sample({ ...competing, activity_id: stravaMember, provider_id: "strava" }),
      sample({ ...competing, activity_id: appleMember, provider_id: "apple_health" }),
      sample({ ...competing, recorded_at: "2026-09-07 09:59:59.999999" }),
      sample({ ...competing, recorded_at: "2026-09-07 10:10:00.000000" }),
    ]);
    expect(await getGhostAltitudeWindow(queryClient, userId, selection)).toEqual(before);
    expect(await altitudeProof(selection)).toEqual(before.proof);
    expect((await getGhostAltitudeWindow(queryClient, otherUserId, selection)).status).toBe(
      "unavailable",
    );
    for (const excluded of [
      { memberActivityId: stravaMember, providerId: "strava" },
      { memberActivityId: appleMember, providerId: "apple_health" },
      { memberActivityId: unrelatedMember, providerId: "garmin" },
      { memberActivityId: garminMember, providerId: "other_provider" },
    ]) {
      const excludedWindow = { ...selection, ...excluded };
      expect((await getGhostAltitudeWindow(queryClient, userId, excludedWindow)).status).toBe(
        "unavailable",
      );
      expect(await altitudeProof(excludedWindow)).toBeNull();
    }

    await insertSamples([
      sample({ ...competing, scalar: 14 }),
      sample({ ...competing, recorded_at: "2026-09-07 10:05:00.123457", scalar: 16 }),
      sample({ ...competing, recorded_at: "2026-09-07 10:05:00.123457", scalar: 16 }),
    ]);
    const conflicting = await getGhostAltitudeWindow(queryClient, userId, selection);
    expect(conflicting.observations).toEqual([
      { timestampMs: Date.parse(recordedAt) + 0.456, altitudeMeters: null },
      { timestampMs: Date.parse(recordedAt) + 0.457, altitudeMeters: 16 },
    ]);
    expect(conflicting.proof?.count).toBe(4);
    expect(await altitudeProof(selection)).toEqual(conflicting.proof);

    await insertSources([
      sourceRecord(garminMember, "garmin", { refresh_version: 2, is_deleted: 1 }),
    ]);
    expect((await getGhostAltitudeWindow(queryClient, userId, selection)).status).toBe(
      "unavailable",
    );
    expect(await altitudeProof(selection)).toBeNull();
  });

  it("fences empty altitude proofs when account erasure starts", async () => {
    await insertSources([sourceRecord(garminMember, "garmin")]);
    const empty = await getGhostAltitudeWindow(queryClient, userId, altitudeWindow);
    expect(empty).toEqual({
      status: "ready",
      observations: [],
      proof: { ...altitudeWindow, count: 0, digest: expect.stringMatching(/^[A-F0-9]{64}$/) },
    });
    expect(await altitudeProof(altitudeWindow)).toEqual(empty.proof);

    await client.insert({
      table: `${database}.account_erasure_fence`,
      format: "JSONEachRow",
      values: [{ user_hash: createHash("sha256").update(userId).digest("hex") }],
    });
    expect((await getGhostAltitudeWindow(queryClient, userId, altitudeWindow)).status).toBe(
      "unavailable",
    );
    expect(await altitudeProof(altitudeWindow)).toBeNull();
  });

  it("validates bounded UTC altitude windows before either query, preserving microseconds", async () => {
    const rejectQuery = () => {
      throw new Error("Invalid altitude window reached ClickHouse");
    };
    for (const bounds of [
      { startedAt: recordedAt, endedAt: "2026-09-08T10:05:00.123457Z" },
      { startedAt: recordedAt, endedAt: "2026-09-07T10:05:00.123455Z" },
      { startedAt: recordedAt, endedAt: recordedAt },
      { startedAt: "2026-09-31T10:05:00.123456Z", endedAt: recordedAt },
      { startedAt: "2026-09-07T10:05:00.123456+00:00", endedAt: recordedAt },
    ]) {
      const invalid = { ...altitudeWindow, ...bounds };
      expect(await getGhostAltitudeWindow({ query: rejectQuery }, userId, invalid)).toEqual({
        status: "unavailable",
        observations: [],
        proof: null,
      });
      expect(await readGhostAltitudeWindowProof(rejectQuery, userId, invalid)).toBeNull();
    }

    await insertSources([sourceRecord(garminMember, "garmin")]);
    await insertSamples([
      sample({ channel: "altitude", device_id: null, measurement_kind: "unknown" }),
    ]);
    for (const endedAt of ["2026-09-07T10:05:00.123457Z", "2026-09-08T10:05:00.123456Z"]) {
      const valid = { ...altitudeWindow, startedAt: recordedAt, endedAt };
      const result = await getGhostAltitudeWindow(queryClient, userId, valid);
      expect(result.proof?.count).toBe(1);
      expect(await altitudeProof(valid)).toEqual(result.proof);
    }
  });

  it("withholds altitude observations and proof at the 20,001-row sentinel", async () => {
    await insertSources([sourceRecord(garminMember, "garmin")]);
    await client.command({
      query: `INSERT INTO ${database}.sensor_scalar_sample
        (id, user_id, activity_id, member_activity_id, provider_id, channel, measurement_kind,
          recorded_date, recorded_at, scalar)
        SELECT generateUUIDv4(), {userId:UUID}, {memberId:UUID}, {memberId:UUID}, 'garmin',
          'altitude', 'unknown', toDate('2026-09-07'),
          fromUnixTimestamp64Micro(1788775500000000 + toInt64(number), 'UTC'), 30
        FROM numbers(20000)`,
      query_params: { userId, memberId: garminMember },
    });
    const bounded = await getGhostAltitudeWindow(queryClient, userId, altitudeWindow);
    expect(bounded.status).toBe("ready");
    expect(bounded.observations).toHaveLength(20_000);
    expect(bounded.proof?.count).toBe(20_000);
    expect(await altitudeProof(altitudeWindow)).toEqual(bounded.proof);

    await insertSamples([
      sample({ channel: "altitude", device_id: null, measurement_kind: "unknown" }),
    ]);
    expect(await getGhostAltitudeWindow(queryClient, userId, altitudeWindow)).toEqual({
      status: "over-limit",
      observations: [],
      proof: null,
    });
    expect(await altitudeProof(altitudeWindow)).toBeNull();
  });

  it("can bound the deduplicated scalar result with a caller-supplied sentinel limit", async () => {
    await insertSources([sourceRecord(garminMember, "garmin")]);
    await insertSamples([
      sample({ scalar: 130 }),
      sample({ provider_id: "strava", scalar: 190 }),
      sample({ recorded_at: "2026-09-07 10:05:01.123456", scalar: 140 }),
      sample({ recorded_at: "2026-09-07 10:05:02.123456", scalar: 150 }),
    ]);
    const bounded = await getGhostScalarSamples(queryClient, { ...window, fetchLimit: 2 });
    expect(bounded.map((row) => row.scalar)).toEqual([130, 140]);
    expect((await getGhostScalarSamples(queryClient, window)).map((row) => row.scalar)).toEqual([
      130, 140, 150,
    ]);
  });

  it("scopes comparison channels before counting observations against the sentinel", async () => {
    await insertSources([sourceRecord(garminMember, "garmin")]);
    await insertSamples([
      sample({ channel: "speed", scalar: 4 }),
      sample({ channel: "altitude", scalar: 200 }),
      sample({ recorded_at: "2026-09-07 10:05:01.123456", scalar: 140 }),
      sample({ recorded_at: "2026-09-07 10:05:02.123456", channel: "power", scalar: 190 }),
    ]);
    const scoped = await getGhostScalarSamples(queryClient, {
      ...window,
      channels: ["heart_rate", "power"],
      fetchLimit: 2,
    });
    expect(scoped.map(({ channel, scalar }) => [channel, scalar])).toEqual([
      ["heart_rate", 140],
      ["power", 190],
    ]);
  });

  it("withholds an over-limit proof and replaces an eligible tombstoned observation in its digest", async () => {
    const heartRate = sample({ scalar: 130 });
    const power = sample({ channel: "power", scalar: 200, measurement_kind: "sampled" });
    await insertSources([sourceRecord(garminMember, "garmin")]);
    await insertSamples([heartRate, power, sample({ channel: "altitude", scalar: 180 })]);
    const interval = {
      activityId,
      memberActivityId: garminMember,
      startedAt: window.startedAt,
      endedAt: window.endedAt,
    };
    expect(await getMeasuredGhostScalarWindow(queryClient, userId, interval, 2)).toEqual({
      rawCount: 2,
      observationRows: [],
      proof: null,
    });
    const before = await getMeasuredGhostScalarWindow(queryClient, userId, interval, 3);
    expect(before.proof?.count).toBe(2);
    expect(before.observationRows).toHaveLength(2);
    await insertSamples([{ ...heartRate, _peerdb_version: 2, _peerdb_is_deleted: 1 }]);
    const after = await getMeasuredGhostScalarWindow(queryClient, userId, interval, 3);
    expect(after.rawCount).toBe(2);
    expect(after.observationRows).toEqual([[recordedAt, "power", 200, "sampled"]]);
    expect(after.proof?.digest).toBeDefined();
    expect(after.proof?.digest).not.toBe(before.proof?.digest);
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
