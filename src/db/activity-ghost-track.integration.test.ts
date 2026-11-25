import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getGhostTrack } from "./activity-ghost-track.ts";
import {
  createActivityLocationSampleSql,
  requireClickHouseUrl,
} from "./activity-payload-dbt-microbatch-test-helpers.ts";
import { createActivitySourceRecordsSql } from "./activity-payload-dbt-source-test-helpers.ts";
import type { ClickHouseClient } from "./clickhouse.ts";

const userId = randomUUID();
const otherUserId = randomUUID();
const activityId = randomUUID();
const otherActivityId = randomUUID();
const garminMember = "00000000-0000-4000-8000-000000000010";
const otherMember = "00000000-0000-4000-8000-000000000020";
const stravaMember = randomUUID();
const input = { userId, activityId };
const sampleTime = "2026-09-07 10:06:00.123456";
const freshness = "2026-09-07 11:00:00.654321987";
const freshnessNs = String(BigInt(Date.UTC(2026, 8, 7, 11)) * 1_000_000n + 654_321_987n);
const firstVersion = "1788778800654321987";

interface SourceRecord {
  activity_id: string;
  group_id: string | null;
  user_id: string | null;
  provider_id: string | null;
  canonical_type: string | null;
  modality: string | null;
  started_at: string | null;
  ended_at: string | null;
  source_name?: string;
  raw?: string;
  source_synced_at: string;
  refresh_version: number;
  is_deleted: number;
}

function sourceRecord(memberActivityId: string, changes: Partial<SourceRecord> = {}): SourceRecord {
  return {
    activity_id: memberActivityId,
    group_id: activityId,
    user_id: userId,
    provider_id: "garmin",
    canonical_type: "cycling",
    modality: "road",
    started_at: "2026-09-07 10:00:00.123456",
    ended_at: "2026-09-07 10:50:00.654321",
    source_synced_at: freshness,
    refresh_version: 1,
    is_deleted: 0,
    ...changes,
  };
}

interface LocationSample {
  member_activity_id: string;
  activity_id: string;
  user_id: string;
  provider_id: string;
  device_id: string | null;
  recorded_at: string;
  recorded_date: string;
  source_metric_stream_id: string;
  lat: number | null;
  lng: number | null;
  refresh_version: string;
  source_refreshed_at: string;
  refreshed_at: string;
  is_deleted: number;
}

function locationSample(changes: Partial<LocationSample> = {}): LocationSample {
  return {
    member_activity_id: garminMember,
    activity_id: activityId,
    user_id: userId,
    provider_id: "garmin",
    device_id: "Edge A",
    recorded_at: sampleTime,
    recorded_date: "2026-09-07",
    source_metric_stream_id: randomUUID(),
    lat: 37.5,
    lng: -122.5,
    refresh_version: firstVersion,
    source_refreshed_at: freshness,
    refreshed_at: freshness,
    is_deleted: 0,
    ...changes,
  };
}

describe("Ghost Sessions track loader", () => {
  const database = `ghost_track_${randomUUID().replaceAll("-", "")}`;
  const locationTable = `${database}.activity_ghost_location_sample`;
  const rowsFetched: number[] = [];
  let client: ReturnType<typeof createClient>;
  const queryClient: Pick<ClickHouseClient, "query"> = {
    query: async <Row extends object>(options: Parameters<ClickHouseClient["query"]>[0]) => {
      const result = await client.query({
        ...options,
        query: options.query.replaceAll("analytics.", `${database}.`),
      });
      return {
        json: async () => {
          const rows = await result.json<Row>();
          rowsFetched.push(rows.length);
          return rows;
        },
      };
    },
  };

  const insertSources = (values: SourceRecord[]) =>
    client.insert({ table: `${database}.activity_source_records`, format: "JSONEachRow", values });
  const insertLocations = (values: LocationSample[]) =>
    client.insert({ table: locationTable, format: "JSONEachRow", values });

  beforeAll(async () => {
    client = createClient({ url: requireClickHouseUrl() });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: createActivitySourceRecordsSql(database) });
    await client.command({
      query: createActivityLocationSampleSql(database)
        .replace(`${database}.activity_location_sample`, locationTable)
        .replace(
          "ORDER BY (user_id, activity_id, source_metric_stream_id)",
          "ORDER BY (user_id, activity_id, recorded_date, recorded_at, source_metric_stream_id)",
        ),
    });
  });

  beforeEach(async () => {
    rowsFetched.length = 0;
    await client.command({ query: `TRUNCATE TABLE ${database}.activity_source_records` });
    await client.command({ query: `TRUNCATE TABLE ${locationTable}` });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("selects the owned direct track ahead of Strava, a wrong owner and a mismatched sample provider", async () => {
    await insertSources([
      sourceRecord(garminMember),
      sourceRecord(stravaMember, { provider_id: "strava" }),
      sourceRecord(otherMember, { user_id: otherUserId }),
    ]);
    await insertLocations([
      locationSample(),
      locationSample({
        provider_id: "strava",
        member_activity_id: stravaMember,
        recorded_at: "2026-09-07 10:01:00",
      }),
      locationSample({
        provider_id: "strava",
        member_activity_id: stravaMember,
        recorded_at: "2026-09-07 10:02:00",
      }),
      locationSample({ member_activity_id: otherMember, recorded_at: "2026-09-07 10:03:00" }),
      locationSample({ provider_id: "wahoo", recorded_at: "2026-09-07 10:04:00" }),
      locationSample({ user_id: otherUserId, recorded_at: "2026-09-07 10:05:00" }),
      locationSample({ activity_id: otherActivityId, recorded_at: "2026-09-07 10:00:00" }),
    ]);

    expect(await getGhostTrack(queryClient, input)).toMatchObject({
      status: "ready",
      memberActivityId: garminMember,
      providerId: "garmin",
      deviceId: "Edge A",
      sport: "cycling",
      modality: "road",
      startedAt: "2026-09-07T10:00:00.123456Z",
      endedAt: "2026-09-07T10:50:00.654321Z",
      refreshVersion: firstVersion,
      sourceRefreshedAtNs: freshnessNs,
      memberSourceSyncedAtNs: freshnessNs,
      points: [{ timestampMs: Date.UTC(2026, 8, 7, 10, 6) + 123.456, lat: 37.5, lng: -122.5 }],
    });
    expect(await getGhostTrack(queryClient, { userId: otherUserId, activityId })).toEqual({
      status: "missing",
    });
  });

  it.each([
    ["source label", { source_name: " STRAVA " }],
    ["source bundle", { source_name: "Watch", raw: '{"sourceBundle":" COM.STRAVA.STRAVA "}' }],
  ])("rejects an Apple Health copy identified by %s", async (_evidence, origin) => {
    await insertSources([
      sourceRecord(garminMember),
      sourceRecord(otherMember, { provider_id: "apple_health", ...origin }),
    ]);
    await insertLocations([
      locationSample(),
      locationSample({
        member_activity_id: otherMember,
        provider_id: "apple_health",
        recorded_at: "2026-09-07 10:01:00",
      }),
      locationSample({
        member_activity_id: otherMember,
        provider_id: "apple_health",
        recorded_at: "2026-09-07 10:02:00",
      }),
    ]);

    expect(await getGhostTrack(queryClient, input)).toMatchObject({
      status: "ready",
      memberActivityId: garminMember,
      providerId: "garmin",
    });
  });

  it.each([
    ["changed groups", { group_id: otherActivityId }],
    ["changed owners", { user_id: otherUserId }],
    ["changed sport", { canonical_type: "hiking" }],
    ["changed modality", { modality: "virtual" }],
    ["was removed", { is_deleted: 1, user_id: null, group_id: null, provider_id: null }],
  ])("rejects the stale GPS projection after the member %s", async (_reason, change) => {
    await insertSources([sourceRecord(garminMember)]);
    await insertLocations([locationSample()]);
    expect(await getGhostTrack(queryClient, input)).toMatchObject({ status: "ready" });

    await insertSources([sourceRecord(garminMember, { ...change, refresh_version: 2 })]);
    expect(await getGhostTrack(queryClient, input)).toEqual({ status: "missing" });
  });

  it("chooses the strongest coherent member and device with a deterministic tie-break", async () => {
    await insertSources([sourceRecord(garminMember), sourceRecord(otherMember)]);
    await insertLocations([
      locationSample({ device_id: "Edge A", recorded_at: "2026-09-07 10:00:00", lat: 38.5 }),
      locationSample({ device_id: "Edge A", recorded_at: "2026-09-07 10:01:00", lat: null }),
      locationSample({ device_id: "Edge A", recorded_at: "2026-09-07 10:02:00", lat: null }),
      ...["Edge C", "Edge B"].flatMap((deviceId) => [
        locationSample({ device_id: deviceId, lat: deviceId === "Edge B" ? 37.5 : 38.5 }),
        locationSample({
          device_id: deviceId,
          recorded_at: "2026-09-07 10:07:00",
          lat: deviceId === "Edge B" ? 37.75 : 38.75,
        }),
      ]),
      locationSample({ member_activity_id: otherMember, device_id: "Edge B", lat: 39.5 }),
      locationSample({
        member_activity_id: otherMember,
        device_id: "Edge B",
        recorded_at: "2026-09-07 10:07:00",
        lat: 39.75,
      }),
    ]);

    const track = await getGhostTrack(queryClient, input);
    expect(track).toMatchObject({
      status: "ready",
      memberActivityId: garminMember,
      deviceId: "Edge B",
      points: [{ lat: 37.5 }, { lat: 37.75 }],
    });
    expect(await getGhostTrack(queryClient, input)).toEqual(track);
  });

  it("ranks four usable timestamps above five identical rows at one timestamp", async () => {
    await insertSources([sourceRecord(garminMember)]);
    await insertLocations([
      ...Array.from({ length: 5 }, () => locationSample()),
      ...[6, 7, 8, 9].map((minute) =>
        locationSample({ device_id: "Edge B", recorded_at: `2026-09-07 10:0${minute}:00` }),
      ),
    ]);

    expect(await getGhostTrack(queryClient, input)).toMatchObject({
      status: "ready",
      deviceId: "Edge B",
      points: [6, 7, 8, 9].map((minute) => ({ timestampMs: Date.UTC(2026, 8, 7, 10, minute) })),
    });
  });

  it.each([
    ["differing coordinates", { lat: 38.5 }, { lng: -123.5 }],
    ["missing coordinates", { lat: null }, { lng: null }],
  ])("excludes timestamps with tied %s from device ranking", async (_reason, first, second) => {
    await insertSources([sourceRecord(garminMember)]);
    await insertLocations([
      ...[1, 2, 3, 4, 5].map((minute) =>
        locationSample({ recorded_at: `2026-09-07 10:0${minute}:00` }),
      ),
      locationSample({ recorded_at: "2026-09-07 10:01:00", ...first }),
      locationSample({ recorded_at: "2026-09-07 10:02:00", ...second }),
      ...[6, 7, 8, 9].map((minute) =>
        locationSample({ device_id: "Edge B", recorded_at: `2026-09-07 10:0${minute}:00` }),
      ),
    ]);

    expect(await getGhostTrack(queryClient, input)).toMatchObject({
      status: "ready",
      deviceId: "Edge B",
      points: [6, 7, 8, 9].map((minute) => ({ timestampMs: Date.UTC(2026, 8, 7, 10, minute) })),
    });
  });

  it("preserves microseconds, tied readings, identical duplicates and a known missing position", async () => {
    await insertSources([
      sourceRecord(otherMember, {
        provider_id: "apple_health",
        source_name: "Watch",
        canonical_type: "running",
        modality: null,
        started_at: null,
        ended_at: null,
      }),
    ]);
    const apple = { provider_id: "apple_health", member_activity_id: otherMember, device_id: null };
    await insertLocations([
      locationSample({ ...apple, source_metric_stream_id: "00000000-0000-4000-8000-000000000001" }),
      locationSample({ ...apple, source_metric_stream_id: "00000000-0000-4000-8000-000000000002" }),
      locationSample({
        ...apple,
        source_metric_stream_id: "00000000-0000-4000-8000-000000000003",
        lat: 38.5,
        lng: -123.5,
      }),
      locationSample({ ...apple, recorded_at: "2026-09-07 10:06:00.123457", lat: null }),
    ]);

    const minute = Date.UTC(2026, 8, 7, 10, 6);
    expect(await getGhostTrack(queryClient, input)).toMatchObject({
      status: "ready",
      memberActivityId: otherMember,
      providerId: "apple_health",
      deviceId: null,
      sport: "running",
      modality: null,
      startedAt: null,
      endedAt: null,
      points: [
        { timestampMs: minute + 123.456, lat: 37.5, lng: -122.5 },
        { timestampMs: minute + 123.456, lat: 37.5, lng: -122.5 },
        { timestampMs: minute + 123.456, lat: 38.5, lng: -123.5 },
        { timestampMs: minute + 123.457, lat: null, lng: -122.5 },
      ],
    });
  });

  it("carries a newer selected-track tombstone version while keeping the rest of its points", async () => {
    await insertSources([sourceRecord(garminMember)]);
    const retained = locationSample();
    const removed = locationSample();
    await insertLocations([retained, removed]);
    expect(await getGhostTrack(queryClient, input)).toMatchObject({ refreshVersion: firstVersion });

    const removalTime = "2026-09-07 11:00:01.654321987";
    const removalVersion = String(BigInt(firstVersion) + 1_000_000_000n);
    await insertLocations([
      {
        ...removed,
        refresh_version: removalVersion,
        source_refreshed_at: removalTime,
        refreshed_at: removalTime,
        is_deleted: 1,
      },
    ]);
    expect(await getGhostTrack(queryClient, input)).toMatchObject({
      status: "ready",
      refreshVersion: removalVersion,
      sourceRefreshedAtNs: String(BigInt(freshnessNs) + 1_000_000_000n),
      points: [{ lat: retained.lat, lng: retained.lng }],
    });
  });

  it("returns exactly 20,000 samples and fetches only one sentinel above the limit", async () => {
    await insertSources([sourceRecord(garminMember)]);
    await client.command({
      query: `INSERT INTO ${locationTable}
        (user_id, activity_id, member_activity_id, provider_id, device_id, recorded_at, recorded_date,
          source_metric_stream_id, lat, lng, refresh_version, refreshed_at, source_refreshed_at)
        SELECT {userId:UUID}, {activityId:UUID}, {memberActivityId:UUID}, 'garmin', 'Edge A',
          addMicroseconds(toDateTime64('2026-09-07 10:00:00', 6, 'UTC'), number),
          toDate('2026-09-07'), generateUUIDv4(), 37.5, -122.5, {version:UInt64},
          toDateTime64({freshness:String}, 9, 'UTC'), toDateTime64({freshness:String}, 9, 'UTC')
        FROM numbers(20000)`,
      query_params: { ...input, memberActivityId: garminMember, version: firstVersion, freshness },
    });
    const full = await getGhostTrack(queryClient, input);
    expect(full).toMatchObject({ status: "ready" });
    expect(full).toHaveProperty("points.length", 20_000);
    expect(rowsFetched).toEqual([20_000]);

    rowsFetched.length = 0;
    await insertLocations([locationSample(), locationSample()]);
    const overLimit = await getGhostTrack(queryClient, input);
    expect(overLimit).toMatchObject({ status: "over-limit", pointLimit: 20_000 });
    expect(overLimit).not.toHaveProperty("points");
    expect(rowsFetched).toEqual([20_001]);
  });
});
