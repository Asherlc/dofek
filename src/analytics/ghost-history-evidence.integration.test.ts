import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createActivityLocationMemberChangeSql,
  createActivityLocationSampleSql,
  requireClickHouseUrl,
} from "../db/activity-payload-dbt-microbatch-test-helpers.ts";
import { createActivitySourceRecordsSql } from "../db/activity-payload-dbt-source-test-helpers.ts";
import { createGhostTrackIndexSql } from "../db/ghost-track-index-schema.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";
import { getGhostHistoryEvidence } from "./ghost-history-evidence.ts";
import { projectGhostTrackIndex } from "./ghost-track-index.ts";

const userId = randomUUID();
const otherOwner = randomUUID();
const preparedAt = "2026-11-22 12:00:00.123456789";
const newMarkerAt = "2026-11-22 13:00:00.123456789";
const initialVersion = "1795348800123456789";
const nextVersion = "1795348801123456789";

function activityId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

interface Fixture {
  activityId: string;
  startedAt: string;
  userId?: string;
  sport?: string;
}

const anchor = { activityId: activityId(1_000), startedAt: "2026-11-20 10:00:00.123456" };
const prior = { activityId: activityId(1), startedAt: "2026-11-19 10:00:00.654321" };
const input = { userId, activityId: anchor.activityId };

function memberId(groupId: string): string {
  return groupId.replace("00000000", "00000001");
}

function source(fixture: Fixture) {
  return {
    activity_id: memberId(fixture.activityId),
    user_id: fixture.userId ?? userId,
    group_id: fixture.activityId,
    provider_id: "garmin",
    canonical_type: fixture.sport ?? "cycling",
    modality: "road",
    started_at: fixture.startedAt,
    ended_at: `${fixture.startedAt.slice(0, 10)} 18:00:00.654321`,
    source_synced_at: preparedAt,
    refresh_version: 1,
    is_deleted: 0,
  };
}

function points(fixture: Fixture, located = true) {
  return [0, 1].map((step) => ({
    user_id: fixture.userId ?? userId,
    activity_id: fixture.activityId,
    member_activity_id: memberId(fixture.activityId),
    provider_id: "garmin",
    device_id: "Direct",
    recorded_at: `${fixture.startedAt.slice(0, 13)}:01:0${step}.123456`,
    recorded_date: fixture.startedAt.slice(0, 10),
    source_metric_stream_id: randomUUID(),
    lat: located ? 37.5 + step * 0.0005 : null,
    lng: located ? -122.5 - step * 0.0005 : null,
    source_refreshed_at: preparedAt,
    refreshed_at: preparedAt,
    refresh_version: initialVersion,
    is_deleted: 0,
  }));
}

const unavailable = {
  anchorStatus: "unavailable",
  historyGeneration: null,
  historyCoverage: "partial",
  checkedGroups: 0,
  checkedActivityIds: [],
  incompleteGroups: 0,
  cutoffReached: false,
};

describe("current Ghost history evidence", () => {
  const database = `ghost_history_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;
  const scope = (query: string) => query.replaceAll(/(?:analytics|ingest)\./g, `${database}.`);
  const owner: Pick<AnalyticsQueryOwner, "client" | "assertActive"> = {
    assertActive: async () => {},
    client: {
      query: (options) => client.query({ ...options, query: scope(options.query) }),
      command: (options) => client.command({ ...options, query: scope(options.query) }),
      insert: (options) => client.insert({ ...options, table: scope(options.table) }),
    },
  };
  const read = (key = input) => getGhostHistoryEvidence(owner.client, key);
  const sources = async (values: ReturnType<typeof source>[]) => {
    await client.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values,
    });
  };
  const locations = async (values: ReturnType<typeof points>) => {
    await client.insert({
      table: `${database}.activity_ghost_location_sample`,
      format: "JSONEachRow",
      values,
    });
  };
  const marker = async (
    fixture: Fixture,
    changedAt = preparedAt,
    memberActivityId = memberId(fixture.activityId),
    hasLiveSample = 1,
  ) => {
    await client.insert({
      table: `${database}.activity_location_member_change`,
      format: "JSONEachRow",
      values: [
        {
          user_id: fixture.userId ?? userId,
          member_activity_id: memberActivityId,
          changed_at: changedAt,
          has_live_sample: hasLiveSample,
        },
      ],
    });
  };

  async function seedPrepared(...fixtures: Fixture[]) {
    await sources(fixtures.map(source));
    await locations(fixtures.flatMap((fixture) => points(fixture)));
    for (const fixture of fixtures) await marker(fixture);
    expect(await projectGhostTrackIndex(owner)).toEqual({ pendingTracks: 0 });
  }

  beforeAll(async () => {
    client = createClient({ url: requireClickHouseUrl() });
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const query of [
      createActivitySourceRecordsSql(database),
      createActivityLocationSampleSql(database).replace(
        "activity_location_sample",
        "activity_ghost_location_sample",
      ),
      createActivityLocationMemberChangeSql(database),
      scope(createGhostTrackIndexSql),
      `CREATE TABLE ${database}.account_erasure_fence (user_hash String)
        ENGINE = ReplacingMergeTree ORDER BY user_hash`,
    ])
      await client.command({ query });
  });

  beforeEach(async () => {
    for (const table of [
      "activity_source_records",
      "activity_ghost_location_sample",
      "activity_location_member_change",
      "ghost_track",
      "account_erasure_fence",
    ])
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("certifies clean normalized history with no earlier GPS", async () => {
    await seedPrepared(anchor);
    const empty = await read();
    expect(empty).toMatchObject({
      anchorStatus: "ready",
      historyCoverage: "complete",
      checkedGroups: 0,
      incompleteGroups: 0,
      cutoffReached: false,
      historyGeneration: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(await read()).toEqual(empty);

    await sources([source(prior)]);
    const withoutGps = await read();
    expect(withoutGps).toMatchObject({
      anchorStatus: "ready",
      historyCoverage: "complete",
      checkedGroups: 1,
      incompleteGroups: 0,
    });
    expect(withoutGps.historyGeneration).not.toBe(empty.historyGeneration);
  });

  it("invalidates on a late earlier GPS import and a marker ahead of the prepared model", async () => {
    await seedPrepared(anchor);
    const before = await read();
    await sources([source(prior)]);
    await marker(prior);
    const pending = await read();
    expect(pending).toMatchObject({
      anchorStatus: "ready",
      historyCoverage: "partial",
      checkedGroups: 1,
      incompleteGroups: 1,
    });
    expect(pending.historyGeneration).not.toBe(before.historyGeneration);

    await locations(points(prior));
    expect(await projectGhostTrackIndex(owner)).toEqual({ pendingTracks: 0 });
    const prepared = await read();
    expect(prepared).toMatchObject({ historyCoverage: "complete", incompleteGroups: 0 });
    expect(prepared.historyGeneration).not.toBe(pending.historyGeneration);

    await marker(prior, newMarkerAt);
    const newer = await read();
    expect(newer).toMatchObject({ historyCoverage: "partial", incompleteGroups: 1 });
    expect(newer.historyGeneration).not.toBe(prepared.historyGeneration);
  });

  it("detects a same-watermark GPS version change and a member moving out of earlier history", async () => {
    const rawPrior = points(prior);
    await seedPrepared(anchor);
    await sources([source(prior)]);
    await marker(prior);
    await locations(rawPrior);
    expect(await projectGhostTrackIndex(owner)).toEqual({ pendingTracks: 0 });
    const prepared = await read();
    expect(prepared.historyCoverage).toBe("complete");

    await locations(rawPrior.map((point) => ({ ...point, refresh_version: nextVersion })));
    const stale = await read();
    expect(stale).toMatchObject({ historyCoverage: "partial", incompleteGroups: 1 });
    expect(stale.historyGeneration).not.toBe(prepared.historyGeneration);

    expect(await projectGhostTrackIndex(owner)).toEqual({ pendingTracks: 0 });
    const rechecked = await read();
    expect(rechecked.historyCoverage).toBe("complete");
    expect(rechecked.historyGeneration).not.toBe(stale.historyGeneration);

    await sources([
      {
        ...source(prior),
        group_id: activityId(3),
        started_at: "2026-11-21 10:00:00",
        refresh_version: 2,
      },
    ]);
    const moved = await read();
    expect(moved).toMatchObject({ historyCoverage: "complete", checkedGroups: 0 });
    expect(moved.historyGeneration).not.toBe(rechecked.historyGeneration);
  });

  it("keeps the generation stable across newer activities and ineligible copied sources", async () => {
    await seedPrepared(anchor, prior);
    const before = await read();
    expect(before.historyCoverage).toBe("complete");

    await seedPrepared(
      { activityId: activityId(2), startedAt: "2026-11-21 10:00:00" },
      { ...prior, activityId: activityId(3), sport: "running" },
    );
    const copies = [
      { ...source(prior), activity_id: memberId(activityId(4)), provider_id: "strava" },
      {
        ...source(prior),
        activity_id: memberId(activityId(5)),
        provider_id: "apple_health",
        raw: '{"sourceBundle":" COM.STRAVA.STRAVA "}',
      },
      {
        ...source(prior),
        activity_id: memberId(activityId(6)),
        provider_id: "apple_health",
        source_name: " STRAVA ",
      },
    ];
    await sources(copies);
    for (const copy of copies) await marker(prior, newMarkerAt, copy.activity_id);
    await marker({ ...prior, userId: otherOwner }, newMarkerAt);
    expect(await read()).toEqual(before);
  });

  it.each([
    ["a later start", { startedAt: "2026-11-21 10:00:00" }],
    ["a different sport", { sport: "running" }],
  ])("checks markers for eligible siblings with %s in an earlier group", async (_, sibling) => {
    await seedPrepared(anchor, prior);
    const siblingId = memberId(activityId(2));
    await sources([{ ...source({ ...prior, ...sibling }), activity_id: siblingId }]);
    expect(await projectGhostTrackIndex(owner)).toEqual({ pendingTracks: 0 });
    const before = await read();
    expect(before).toMatchObject({ anchorStatus: "ready", historyCoverage: "complete" });

    await marker(prior, newMarkerAt, siblingId);

    const after = await read();
    expect(after).toMatchObject({
      anchorStatus: "ready",
      historyCoverage: "partial",
      incompleteGroups: 1,
    });
    expect(after.historyGeneration).not.toBe(before.historyGeneration);
  });

  it("keeps earlier unlocated and over-limit work partial", async () => {
    const overLimit = { ...prior, activityId: activityId(2) };
    await seedPrepared(anchor, overLimit);
    await sources([source(prior)]);
    await marker(prior);
    await locations(points(prior, false));
    expect(await projectGhostTrackIndex(owner)).toEqual({ pendingTracks: 0 });
    const unlocated = await read();
    expect(unlocated).toMatchObject({
      historyCoverage: "partial",
      checkedGroups: 2,
      incompleteGroups: 1,
    });

    await owner.client.command({
      query: `INSERT INTO analytics.ghost_track
        SELECT * REPLACE('over-limit' AS status, toUInt32(20001) AS point_count,
          refresh_version + 1 AS refresh_version)
        FROM analytics.ghost_track FINAL WHERE activity_id = {activityId:UUID}`,
      query_params: { activityId: overLimit.activityId },
    });
    const boundedTrack = await read();
    expect(boundedTrack).toMatchObject({
      historyCoverage: "partial",
      checkedGroups: 2,
      incompleteGroups: 2,
    });
    expect(boundedTrack.historyGeneration).not.toBe(unlocated.historyGeneration);
  });

  it("keeps a missing earlier track partial when the compact marker still reports past GPS", async () => {
    const rawPrior = points(prior);
    await seedPrepared(anchor);
    await sources([source(prior)]);
    await marker(prior);
    await locations(
      rawPrior.map((point) => ({
        ...point,
        is_deleted: 1,
        refresh_version: nextVersion,
      })),
    );
    expect(await projectGhostTrackIndex(owner)).toEqual({ pendingTracks: 0 });
    expect(await read()).toMatchObject({
      anchorStatus: "ready",
      historyCoverage: "partial",
      checkedGroups: 1,
      incompleteGroups: 1,
    });
  });

  it("returns a stable generation for the checked prefix beyond the group cutoff", async () => {
    await seedPrepared(anchor);
    const earlier = Array.from({ length: 257 }, (_, index) => ({
      ...prior,
      activityId: activityId(index + 1),
    }));
    await sources(earlier.map(source));
    const prefix = await read();
    expect(prefix).toMatchObject({
      anchorStatus: "ready",
      historyCoverage: "partial",
      cutoffReached: true,
      checkedGroups: 256,
      checkedActivityIds: earlier.slice(1).map((fixture) => fixture.activityId),
      historyGeneration: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    await sources([
      {
        ...source(prior),
        source_synced_at: newMarkerAt,
        refresh_version: 2,
      },
    ]);
    expect(await read()).toEqual(prefix);

    await sources([
      {
        ...source({ ...prior, activityId: activityId(2) }),
        source_synced_at: newMarkerAt,
        refresh_version: 2,
      },
    ]);
    expect((await read()).historyGeneration).not.toBe(prefix.historyGeneration);
  });

  it("withholds a generation when the anchor input is stale", async () => {
    await seedPrepared(anchor);
    expect((await read()).anchorStatus).toBe("ready");
    await marker(anchor, newMarkerAt);
    expect(await read()).toEqual({ ...unavailable, anchorStatus: "pending" });
  });

  it("isolates owners and hides the entire anchor evidence after erasure", async () => {
    await seedPrepared(anchor, prior);
    const own = await read();
    expect(own.anchorStatus).toBe("ready");
    await seedPrepared({ ...prior, activityId: activityId(10), userId: otherOwner });
    expect(await read()).toEqual(own);
    expect(await read({ ...input, userId: otherOwner })).toEqual(unavailable);

    await owner.client.command({
      query: `INSERT INTO ingest.account_erasure_fence (user_hash)
        SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
      query_params: { userId },
    });
    expect(await read()).toEqual(unavailable);
  });
});
