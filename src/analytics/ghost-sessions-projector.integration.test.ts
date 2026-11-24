import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { BLE_HEART_RATE_PROVIDER_ID } from "@dofek/providers/push-providers";
import { ghostSessionsCompareResponseSchema } from "@dofek/training/ghost-sessions";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createActivityLocationSampleSql,
  requireClickHouseUrl,
} from "../db/activity-payload-dbt-microbatch-test-helpers.ts";
import { createActivitySourceRecordsSql } from "../db/activity-payload-dbt-source-test-helpers.ts";
import { buildIncrementalDedupedSensorBaseTableStatements } from "../db/clickhouse-deduped-sensor.ts";
import { createMigration as createIndexMigration } from "../db/clickhouse-migrations/0120_ghost_track_index.ts";
import { createMigration as createResultMigration } from "../db/clickhouse-migrations/0121_ghost_session_results.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";
import { projectGhostSessionsPage } from "./ghost-sessions-projector.ts";
import { projectGhostTrackIndex } from "./ghost-track-index.ts";

type ProjectionOwner = Pick<AnalyticsQueryOwner, "client" | "assertActive">;

const userId = randomUUID();
const otherOwner = randomUUID();
const anchorStartedAt = "2026-10-10T10:00:00.123456Z";
const newerStartedAt = "2026-10-09T10:00:00.123456Z";
const olderStartedAt = "2026-10-08T10:00:00.123456Z";
const sourceWatermark = "2026-10-11 10:00:00.123456789";
const updatedWatermark = "2026-10-12 10:00:00.123456789";
const version = "1791712800123456789";
const updatedVersion = "1791799200123456789";
const degreesPerMeter = 180 / (Math.PI * 6_371_000);
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const memberId = (activityId: string) => activityId.replace("00000000", "00000001");
const offsetTime = (startedAt: string, milliseconds: number) =>
  new Date(Date.parse(startedAt) + milliseconds).toISOString().replace("Z", "456Z");
const timestampMs = (startedAt: string) => Date.parse(startedAt) + 0.456;
const dbTime = (iso: string) => iso.replace("T", " ").replace("Z", "");

interface TrackFixture {
  activityId: string;
  startedAt: string;
  owner?: string;
  sport?: "running" | "cycling";
  eastOffset?: number;
  stepMs?: number;
  coordinates?: readonly (readonly [number, number])[];
  updated?: boolean;
}

function trackPositions(fixture: TrackFixture): readonly (readonly [number, number])[] {
  return (
    fixture.coordinates ??
    Array.from({ length: 21 }, (_, index) => [index * 20 + (fixture.eastOffset ?? 0), 0])
  );
}

function squareLaps(): readonly (readonly [number, number])[] {
  const corners = [
    [0, 0],
    [200, 0],
    [200, 200],
    [0, 200],
    [0, 0],
  ] as const;
  const lap = corners.slice(0, -1).flatMap(([east, north], index) => {
    const next = corners[index + 1];
    if (!next) throw new Error("Expected a corner");
    return Array.from(
      { length: 10 },
      (_, step) =>
        [east + ((next[0] - east) * step) / 10, north + ((next[1] - north) * step) / 10] as const,
    );
  });
  return [...lap, ...lap, [0, 0]];
}

interface SavedPair {
  section_id: string;
  pass_id: string;
  match_kind: "full-route" | "shared-stretch";
  candidate_activity_id: string;
  candidate_started_at: string;
  candidate_pass_started_at_ms: number;
  candidate_pass_ended_at_ms: number;
  candidate_elapsed_ms: number;
  anchor_interval: string;
  candidate_stamp: string;
  scalar_proof: string;
  comparison: string;
}

interface SavedPage {
  anchor_generation: string;
  history_generation: string;
  request_cursor: string;
  next_cursor: string | null;
  history_coverage: string;
  source_history_coverage: string;
  anchor_summary: string | null;
  matches: SavedPair[];
  payload_digest: string;
  refresh_version: string;
}

describe("Ghost Sessions timed comparison projection", () => {
  const database = `ghost_projection_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;
  const scope = (query: string) => query.replaceAll(/(?:analytics|ingest)\./g, `${database}.`);
  const anchor = { activityId: id(1), startedAt: anchorStartedAt };
  const newer = { activityId: id(2), startedAt: newerStartedAt, eastOffset: 10, stepMs: 2_000 };
  const older = { activityId: id(3), startedAt: olderStartedAt, eastOffset: 100, stepMs: 3_000 };
  const input = {
    userId,
    activityId: anchor.activityId,
    historyGeneration: "history-v1",
    sourceHistoryCoverage: "unverified",
  } as const;
  const owner = (
    beforeWrite?: () => Promise<void>,
    beforeTrackLoad?: (activityId: string) => Promise<void>,
  ): ProjectionOwner => ({
    assertActive: async () => {},
    client: {
      query: async (options) => {
        if (options.query_params?.pointFetchLimit)
          await beforeTrackLoad?.(String(options.query_params.activityId));
        return client.query({ ...options, query: scope(options.query) });
      },
      command: async (options) => {
        if (options.query.startsWith("INSERT INTO analytics.ghost_session_page"))
          await beforeWrite?.();
        return client.command({ ...options, query: scope(options.query) });
      },
      insert: (options) => client.insert({ ...options, table: scope(options.table) }),
    },
  });

  async function seed(...fixtures: TrackFixture[]) {
    await client.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values: fixtures.map((fixture) => ({
        activity_id: memberId(fixture.activityId),
        group_id: fixture.activityId,
        user_id: fixture.owner ?? userId,
        provider_id: "garmin",
        canonical_type: fixture.sport ?? "cycling",
        modality: "road",
        started_at: dbTime(fixture.startedAt),
        ended_at: dbTime(
          offsetTime(
            fixture.startedAt,
            (trackPositions(fixture).length - 1) * (fixture.stepMs ?? 1_000),
          ),
        ),
        source_synced_at: fixture.updated ? updatedWatermark : sourceWatermark,
        refresh_version: fixture.updated ? 2 : 1,
      })),
    });
    await client.insert({
      table: `${database}.activity_ghost_location_sample`,
      format: "JSONEachRow",
      values: fixtures.flatMap((fixture) =>
        trackPositions(fixture).map(([east, north], index) => ({
          user_id: fixture.owner ?? userId,
          activity_id: fixture.activityId,
          member_activity_id: memberId(fixture.activityId),
          provider_id: "garmin",
          device_id: "Direct recording",
          recorded_at: dbTime(offsetTime(fixture.startedAt, index * (fixture.stepMs ?? 1_000))),
          recorded_date: fixture.startedAt.slice(0, 10),
          source_metric_stream_id: id(100 * Number(fixture.activityId.slice(-4)) + index),
          lat: north * degreesPerMeter,
          lng: east * degreesPerMeter,
          source_refreshed_at: fixture.updated ? updatedWatermark : sourceWatermark,
          refreshed_at: fixture.updated ? updatedWatermark : sourceWatermark,
          refresh_version: fixture.updated ? updatedVersion : version,
          is_deleted: 0,
        })),
      ),
    });
  }

  async function scalar(
    fixture: TrackFixture,
    channel: "heart_rate" | "power",
    count: number,
    value: number,
    standalone = false,
  ) {
    const values = Array.from({ length: count }, (_, index) => ({
      id: randomUUID(),
      user_id: userId,
      activity_id: standalone ? null : memberId(fixture.activityId),
      member_activity_id: standalone ? null : memberId(fixture.activityId),
      device_id: "Direct recording",
      provider_id: standalone ? BLE_HEART_RATE_PROVIDER_ID : "garmin",
      source_type: standalone ? "ble" : "api",
      recorded_date: fixture.startedAt.slice(0, 10),
      recorded_at: dbTime(offsetTime(fixture.startedAt, index * 1_000)),
      channel,
      scalar: value,
      provider_priority: 20,
      _peerdb_version: 1,
      _peerdb_is_deleted: 0,
    }));
    await client.insert({
      table: `${database}.sensor_scalar_sample`,
      format: "JSONEachRow",
      values,
    });
    return values;
  }

  async function readPages(final = true) {
    const result = await client.query({
      query: `SELECT * EXCEPT (refresh_version), toString(refresh_version) AS refresh_version
        FROM ${database}.ghost_session_page ${final ? "FINAL" : ""}
        ORDER BY history_generation, request_cursor`,
      format: "JSONEachRow",
      clickhouse_settings: { output_format_json_named_tuples_as_objects: 1 },
    });
    return result.json<SavedPage>();
  }

  beforeAll(async () => {
    client = createClient({ url: requireClickHouseUrl() });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: createActivitySourceRecordsSql(database) });
    await client.command({
      query: createActivityLocationSampleSql(database)
        .replace("activity_location_sample", "activity_ghost_location_sample")
        .replace(
          "ORDER BY (user_id, activity_id, source_metric_stream_id)",
          "ORDER BY (user_id, activity_id, recorded_date, recorded_at, source_metric_stream_id)",
        )
        .replace(
          "\n  ) ENGINE",
          `,\n    PROJECTION by_activity_location_source_refresh (
            SELECT activity_id, user_id, max(greatest(source_refreshed_at, refreshed_at)) AS source_refreshed_at
            GROUP BY activity_id, user_id
          )\n  ) ENGINE`,
        )
        .concat(" SETTINGS deduplicate_merge_projection_mode = 'rebuild'"),
    });
    await client.command({
      query: `CREATE TABLE ${database}.account_erasure_fence (user_hash String)
        ENGINE = ReplacingMergeTree ORDER BY user_hash`,
    });
    for (const query of [
      ...buildIncrementalDedupedSensorBaseTableStatements(),
      ...(createIndexMigration().statements ?? []),
      ...(createResultMigration().statements ?? []),
    ])
      await client.command({ query: scope(query) });
  });

  beforeEach(async () => {
    for (const table of [
      "activity_source_records",
      "activity_ghost_location_sample",
      "ghost_track",
      "account_erasure_fence",
      "sensor_scalar_sample",
      "ghost_session_page",
    ])
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("preserves a timed recorded anchor and its route geometry when there are no earlier candidates", async () => {
    await seed(anchor);
    await projectGhostTrackIndex(owner());
    expect(
      await projectGhostSessionsPage(owner(), { ...input, sourceHistoryCoverage: "complete" }),
    ).toMatchObject({ status: "published", historyCoverage: "unverified", nextCursor: null });
    const [page] = await readPages();
    expect(page?.source_history_coverage).toBe("complete");
    expect(page?.matches).toEqual([]);
    const summary = JSON.parse(page?.anchor_summary ?? "null");
    expect(summary).toMatchObject({
      gpsCoverage: "complete",
      anchor: {
        start: { timestampMs: timestampMs(anchorStartedAt) },
        end: { timestampMs: timestampMs(anchorStartedAt) + 20_000 },
        elapsedMs: 20_000,
      },
    });
    expect(summary.geometry).toHaveLength(1);
    expect(summary.geometry[0][0]).toEqual({ lat: 0, lng: 0 });
    expect(summary.geometry[0].at(-1).lng).toBeCloseTo(400 * degreesPerMeter, 12);
  });

  it("persists independent elapsed values, replay coordinates and split boundaries with scoped sensor evidence", async () => {
    await seed(anchor, newer, older, { ...newer, activityId: id(4), owner: otherOwner });
    await scalar(anchor, "heart_rate", 20, 132);
    await scalar(anchor, "power", 20, 0);
    await scalar(newer, "heart_rate", 10, 141);
    await scalar(newer, "power", 40, 220);
    await projectGhostTrackIndex(owner());

    expect(await projectGhostSessionsPage(owner(), input)).toMatchObject({
      status: "published",
      historyCoverage: "unverified",
      nextCursor: null,
    });
    const [page] = await readPages();
    expect(page?.history_coverage).toBe("unverified");
    expect(page?.matches.map((pair) => pair.candidate_activity_id)).toEqual([
      newer.activityId,
      older.activityId,
    ]);
    expect(new Set(page?.matches.map((pair) => pair.section_id)).size).toBe(2);

    const newest = ghostSessionsCompareResponseSchema.parse(
      JSON.parse(page?.matches[0]?.comparison ?? "null"),
    );
    const prior = ghostSessionsCompareResponseSchema.parse(
      JSON.parse(page?.matches[1]?.comparison ?? "null"),
    );
    expect(newest).toMatchObject({
      anchor: { start: { timestampMs: timestampMs(anchorStartedAt) + 500 }, elapsedMs: 19_500 },
      candidate: { start: { timestampMs: timestampMs(newerStartedAt) }, elapsedMs: 39_000 },
      elapsedDifferenceMs: -19_500,
      metrics: {
        heartRateBpm: null,
        powerWatts: { anchor: 0, candidate: 220 },
        paceSecondsPerKm: null,
      },
    });
    expect(newest.replay?.[0]?.anchor.lng).toBeCloseTo(10 * degreesPerMeter, 12);
    expect(newest.replay?.at(-1)?.candidate.lng).toBeCloseTo(400 * degreesPerMeter, 12);
    expect(JSON.parse(page?.matches[0]?.anchor_interval ?? "null")).toEqual(newest.anchor);
    expect(page?.matches[0]).toMatchObject({
      candidate_pass_started_at_ms: newest.candidate.start.timestampMs,
      candidate_pass_ended_at_ms: newest.candidate.end.timestampMs,
      candidate_elapsed_ms: newest.candidate.elapsedMs,
    });
    expect(JSON.parse(page?.matches[0]?.scalar_proof ?? "null")).toMatchObject([
      {
        activityId: anchor.activityId,
        count: expect.any(Number),
        digest: expect.stringMatching(/^[A-F0-9]{64}$/),
      },
      {
        activityId: newer.activityId,
        count: expect.any(Number),
        digest: expect.stringMatching(/^[A-F0-9]{64}$/),
      },
    ]);
    expect(JSON.parse(page?.matches[1]?.scalar_proof ?? "null")).toEqual([]);
    expect(prior).toMatchObject({
      anchor: { start: { timestampMs: timestampMs(anchorStartedAt) + 5_000 }, elapsedMs: 15_000 },
      candidate: { elapsedMs: 45_000 },
      elapsedDifferenceMs: -30_000,
    });
  });

  it("persists only the distinct earlier nonoverlapping lap from the anchor activity", async () => {
    await seed({ ...anchor, coordinates: squareLaps() }, newer);
    await projectGhostTrackIndex(owner());
    await projectGhostSessionsPage(owner(), { ...input, candidateActivityIds: [] });
    const [page] = await readPages();
    expect(page?.matches).toHaveLength(1);
    expect(page?.matches[0]).toMatchObject({
      candidate_activity_id: anchor.activityId,
      match_kind: "shared-stretch",
    });
    expect(JSON.parse(page?.matches[0]?.comparison ?? "null")).toMatchObject({
      anchor: { start: { timestampMs: timestampMs(anchorStartedAt) + 40_000 }, elapsedMs: 40_000 },
      candidate: { start: { timestampMs: timestampMs(anchorStartedAt) }, elapsedMs: 40_000 },
      elapsedDifferenceMs: 0,
    });
  });

  it("advances one stable metadata page per call and leaves an unchanged retry idempotent", async () => {
    const candidates = Array.from({ length: 26 }, (_, index) => ({
      activityId: id(index + 2),
      startedAt: offsetTime(newerStartedAt, -60_000 * index),
    }));
    await seed(anchor, ...candidates);
    await projectGhostTrackIndex(owner());
    await projectGhostTrackIndex(owner());
    const first = await projectGhostSessionsPage(owner(), input);
    expect(first.nextCursor?.activityId).toBe(id(26));
    const firstPages = await readPages();
    expect(firstPages).toHaveLength(1);
    expect(firstPages[0]?.matches).toHaveLength(25);
    expect(first).toMatchObject({
      pageReceipt: {
        payloadDigest: firstPages[0]?.payload_digest,
        refreshVersion: firstPages[0]?.refresh_version,
        bounded: false,
      },
    });
    expect(await projectGhostSessionsPage(owner(), input)).toEqual(first);
    expect(await readPages(false)).toHaveLength(1);
    if (!first.nextCursor) throw new Error("Expected a next cursor");
    expect(
      await projectGhostSessionsPage(owner(), { ...input, before: first.nextCursor }),
    ).toMatchObject({
      status: "published",
      nextCursor: null,
      historyCoverage: "unverified",
    });
    const pages = await readPages();
    expect(pages).toHaveLength(2);
    expect(pages[1]?.matches.map((pair) => pair.candidate_activity_id)).toEqual([id(27)]);
  });

  it("keeps changed source generations separate and records the replacement evidence", async () => {
    await seed(anchor, newer);
    await projectGhostTrackIndex(owner());
    await projectGhostSessionsPage(owner(), input);
    await seed({ ...newer, updated: true, eastOffset: 20 });
    await projectGhostTrackIndex(owner());
    await projectGhostSessionsPage(owner(), { ...input, historyGeneration: "history-v2" });

    const pages = await readPages();
    expect(pages.map((page) => page.history_generation)).toEqual(["history-v1", "history-v2"]);
    expect(pages[0]?.anchor_generation).toBe(pages[1]?.anchor_generation);
    expect(JSON.parse(pages[0]?.matches[0]?.candidate_stamp ?? "null")).toMatchObject({
      refreshVersion: version,
    });
    expect(JSON.parse(pages[1]?.matches[0]?.candidate_stamp ?? "null")).toMatchObject({
      refreshVersion: updatedVersion,
    });
    expect(JSON.parse(pages[1]?.matches[0]?.comparison ?? "null")).toMatchObject({
      anchor: { start: { timestampMs: timestampMs(anchorStartedAt) + 1_000 }, elapsedMs: 19_000 },
      candidate: { elapsedMs: 38_000 },
    });
  });

  it("rejects a changed candidate after discovery and before its GPS load", async () => {
    await seed(anchor, newer);
    await projectGhostTrackIndex(owner());
    let loaded = false;
    const result = await projectGhostSessionsPage(
      owner(undefined, async (activityId) => {
        if (loaded || activityId !== newer.activityId) return;
        loaded = true;
        await seed({ ...newer, updated: true, eastOffset: 20 });
      }),
      input,
    );
    expect(loaded).toBe(true);
    expect(result).toMatchObject({ status: "stale", nextCursor: null });
    expect(await readPages()).toEqual([]);
  });

  it.each([
    ["linked replacement", "power", false],
    ["standalone Bluetooth tombstone", "heart_rate", true],
  ] as const)(
    "rejects a %s without a GPS or member version change",
    async (_race, channel, standalone) => {
      await seed(anchor, newer);
      await scalar(anchor, channel, 20, 130);
      const values = await scalar(newer, channel, 40, 200, standalone);
      await projectGhostTrackIndex(owner());
      let raced = false;
      const result = await projectGhostSessionsPage(
        owner(async () => {
          if (raced) return;
          raced = true;
          await client.insert({
            table: `${database}.sensor_scalar_sample`,
            format: "JSONEachRow",
            values: values.map((value) => ({
              ...value,
              scalar: 240,
              _peerdb_version: 2,
              _peerdb_is_deleted: Number(standalone),
            })),
          });
        }),
        input,
      );
      expect(raced).toBe(true);
      expect(result).toMatchObject({ status: "stale", nextCursor: null });
      expect(await readPages()).toEqual([]);
    },
  );

  it.each(["erasure", "source change"] as const)(
    "suppresses page publication after a %s race",
    async (race) => {
      await seed(anchor, newer);
      await projectGhostTrackIndex(owner());
      let raced = false;
      const result = await projectGhostSessionsPage(
        owner(async () => {
          if (raced) return;
          raced = true;
          if (race === "erasure") {
            await client.command({
              query: `INSERT INTO ${database}.account_erasure_fence (user_hash)
            SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
              query_params: { userId },
            });
          } else {
            await seed({ ...newer, updated: true, eastOffset: 20 });
          }
        }),
        input,
      );
      expect(raced).toBe(true);
      expect(result).toMatchObject({ status: "stale", nextCursor: null });
      expect(await readPages()).toEqual([]);
    },
  );
});
