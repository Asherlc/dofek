import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createActivityLocationSampleSql,
  requireClickHouseUrl,
} from "../db/activity-payload-dbt-microbatch-test-helpers.ts";
import { createActivitySourceRecordsSql } from "../db/activity-payload-dbt-source-test-helpers.ts";
import { createMigration } from "../db/clickhouse-migrations/0120_ghost_track_index.ts";
import { readModelSql } from "../db/read-model-sql-test-helpers.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";
import { listGhostTrackCandidates, projectGhostTrackIndex } from "./ghost-track-index.ts";

type IndexOwner = Pick<AnalyticsQueryOwner, "client" | "assertActive">;
type InventoryQuery = Parameters<IndexOwner["client"]["query"]>[0] & { query_id: string };

const firstOwner = randomUUID();
const secondOwner = randomUUID();
const baseTime = "2026-10-10 10:00:00.123456";
const baseWatermark = "2026-10-11 10:00:00.123456789";
const baseVersion = "1791712800123456789";
const movedVersion = "1791712801123456789";
const projectionName = "by_activity_location_source_refresh";
const bulkPointCount = 20_001;

function activityId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

interface TrackFixture {
  activityId: string;
  userId?: string;
  sport?: string;
  startedAt?: string;
  watermark?: string;
  positions?: ReadonlyArray<readonly [number | null, number | null]>;
}

describe("Ghost Sessions compact track index", () => {
  const databaseName = `ghost_index_${randomUUID().replaceAll("-", "")}`;
  let clickhouse: ReturnType<typeof createClient>;
  const reads: string[] = [];
  const scope = (query: string) => query.replaceAll(/(?:analytics|ingest)\./g, `${databaseName}.`);
  const fenceTable = `${databaseName}.account_erasure_fence`;

  const makeOwner = (
    hooks: {
      beforeTrackRead?: () => Promise<void>;
      beforeWrite?: () => Promise<void>;
      inventory?: InventoryQuery[];
    } = {},
  ): IndexOwner => ({
    assertActive: async () => {},
    client: {
      query: async (options) => {
        if (options.query_params?.pointFetchLimit) {
          reads.push(String(options.query_params.activityId));
          await hooks.beforeTrackRead?.();
        }
        if (hooks.inventory && options.query.includes("FULL OUTER JOIN published")) {
          const inventoryQuery = {
            ...options,
            query_id: randomUUID(),
            clickhouse_settings: {
              ...options.clickhouse_settings,
              log_queries: 1 as const,
              log_queries_min_query_duration_ms: 0,
            },
          };
          hooks.inventory.push(inventoryQuery);
          return clickhouse.query({ ...inventoryQuery, query: scope(inventoryQuery.query) });
        }
        return clickhouse.query({ ...options, query: scope(options.query) });
      },
      command: async (options) => {
        if (options.query.startsWith("INSERT INTO analytics.ghost_track")) {
          await hooks.beforeWrite?.();
        }
        return clickhouse.command({ ...options, query: scope(options.query) });
      },
      insert: (options) => clickhouse.insert({ ...options, table: scope(options.table) }),
    },
  });

  const memberId = (groupId: string) => groupId.replace("00000000", "00000001");

  function source(fixture: TrackFixture) {
    return {
      activity_id: memberId(fixture.activityId),
      group_id: fixture.activityId,
      user_id: fixture.userId ?? firstOwner,
      provider_id: "garmin",
      canonical_type: fixture.sport ?? "cycling",
      modality: "road",
      name: "Same workout name",
      started_at: fixture.startedAt ?? baseTime,
      ended_at: `${(fixture.startedAt ?? baseTime).slice(0, 10)} 23:00:00.654321`,
      source_synced_at: baseWatermark,
      refresh_version: 1,
    };
  }

  function points(fixture: TrackFixture) {
    return (
      fixture.positions ?? [
        [37.5, -122.5],
        [37.5005, -122.5005],
      ]
    ).map(([latitude, longitude], index) => ({
      user_id: fixture.userId ?? firstOwner,
      activity_id: fixture.activityId,
      member_activity_id: memberId(fixture.activityId),
      provider_id: "garmin",
      device_id: "Direct recording",
      recorded_at: `${(fixture.startedAt ?? baseTime).slice(0, 13)}:01:0${index}.123456`,
      recorded_date: (fixture.startedAt ?? baseTime).slice(0, 10),
      source_metric_stream_id: randomUUID(),
      lat: latitude,
      lng: longitude,
      source_refreshed_at: fixture.watermark ?? baseWatermark,
      refreshed_at: fixture.watermark ?? baseWatermark,
      refresh_version: baseVersion,
      is_deleted: 0,
    }));
  }

  const insertSources = (values: ReturnType<typeof source>[]) =>
    clickhouse.insert({
      table: `${databaseName}.activity_source_records`,
      format: "JSONEachRow",
      values,
    });
  const insertPoints = (values: ReturnType<typeof points>) =>
    clickhouse.insert({
      table: `${databaseName}.activity_ghost_location_sample`,
      format: "JSONEachRow",
      values,
    });
  const seed = async (...fixtures: TrackFixture[]) => {
    await insertSources(fixtures.map(source));
    await insertPoints(fixtures.flatMap(points));
  };
  const fence = (userId: string) =>
    clickhouse.command({
      query: `INSERT INTO ${fenceTable} (user_hash)
        SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
      query_params: { userId },
    });

  async function state() {
    const result = await makeOwner().client.query({
      query: `SELECT activity_id, status, sport, member_activity_id, point_count,
        toString(gps_refresh_version) AS gps_refresh_version,
        min_lat, max_lat, min_lng, max_lng
      FROM analytics.ghost_track FINAL ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    return result.json();
  }

  async function createProjectedLocationTable(table: string, modelFile: string) {
    const projectionQuery = readModelSql(modelFile).match(
      /'name': 'by_activity_location_source_refresh',\s*'query': '([^']+)'/,
    )?.[1];
    if (!projectionQuery) throw new Error(`Missing source refresh projection in ${modelFile}`);
    await clickhouse.command({
      query: createActivityLocationSampleSql(databaseName)
        .replace("activity_location_sample", table)
        .replace(
          "ORDER BY (user_id, activity_id, source_metric_stream_id)",
          "ORDER BY (user_id, activity_id, recorded_date, recorded_at, source_metric_stream_id)",
        )
        .replace(
          "\n  ) ENGINE",
          `,\n    PROJECTION ${projectionName} (${projectionQuery})\n  ) ENGINE`,
        )
        .concat(" SETTINGS deduplicate_merge_projection_mode = 'rebuild'"),
    });
  }

  beforeAll(async () => {
    clickhouse = createClient({ url: requireClickHouseUrl() });
    await clickhouse.command({ query: `CREATE DATABASE ${databaseName}` });
    await clickhouse.command({ query: createActivitySourceRecordsSql(databaseName) });
    await createProjectedLocationTable(
      "activity_ghost_location_sample",
      "activity_ghost_location_sample.sql",
    );
    await clickhouse.command({
      query: `CREATE TABLE ${fenceTable} (user_hash String)
        ENGINE = ReplacingMergeTree ORDER BY user_hash`,
    });
    for (const query of createMigration().statements ?? []) {
      await clickhouse.command({ query: scope(query) });
    }
  });

  beforeEach(async () => {
    reads.length = 0;
    await clickhouse.command({
      query: `DROP TABLE IF EXISTS ${databaseName}.activity_ghost_location_sample_prior SYNC`,
    });
    for (const table of [
      "activity_source_records",
      "activity_ghost_location_sample",
      "ghost_track",
      "account_erasure_fence",
    ]) {
      await clickhouse.command({ query: `TRUNCATE TABLE ${databaseName}.${table}` });
    }
  });

  afterAll(async () => {
    await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${databaseName} SYNC` });
    await clickhouse.close();
  });

  it("publishes compact coherent track metadata and ignores unchanged source-model re-emission", async () => {
    const fixture = { activityId: activityId(1) };
    await seed(fixture);
    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    expect(await state()).toEqual([
      {
        activity_id: fixture.activityId,
        member_activity_id: memberId(fixture.activityId),
        status: "ready",
        sport: "cycling",
        point_count: 2,
        gps_refresh_version: baseVersion,
        min_lat: 37.5,
        max_lat: 37.5005,
        min_lng: -122.5005,
        max_lng: -122.5,
      },
    ]);

    await insertSources([{ ...source(fixture), refresh_version: 2 }]);
    expect(
      await projectGhostTrackIndex(
        makeOwner({
          beforeWrite: async () => {
            throw new Error("Unchanged input attempted publication");
          },
        }),
      ),
    ).toEqual({ pendingTracks: 0 });
    expect(reads).toEqual([fixture.activityId]);
  });

  it("ignores revisions to Strava and recognized Apple Health copy siblings", async () => {
    const fixture = { activityId: activityId(1) };
    await seed(fixture);
    const strava = {
      ...source(fixture),
      activity_id: memberId(activityId(2)),
      provider_id: "strava",
    };
    const appleCopy = {
      ...source(fixture),
      activity_id: memberId(activityId(3)),
      provider_id: "apple_health",
      raw: '{"sourceBundle":" COM.STRAVA.STRAVA "}',
    };
    await insertSources([strava, appleCopy]);
    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    const before = await state();
    await insertSources(
      [strava, appleCopy].map((sibling) => ({
        ...sibling,
        source_synced_at: "2026-10-11 11:00:00",
        refresh_version: 2,
      })),
    );
    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    expect(reads).toEqual([fixture.activityId]);
    expect(await state()).toEqual(before);
  });

  it("invalidates all removed GPS points when only the model version advances", async () => {
    const fixture = { activityId: activityId(1) };
    const original = points(fixture);
    await insertSources([source(fixture)]);
    await insertPoints(original);
    await projectGhostTrackIndex(makeOwner());

    const watermark = async () => {
      const result = await clickhouse.query({
        query:
          scope(`SELECT toString(max(greatest(source_refreshed_at, refreshed_at))) AS watermark,
            toString(max(refresh_version)) AS version
          FROM analytics.activity_ghost_location_sample`),
        format: "JSONEachRow",
      });
      return (await result.json())[0];
    };
    expect(await watermark()).toEqual({ watermark: baseWatermark, version: baseVersion });
    await insertPoints(
      original.map((point) => ({ ...point, is_deleted: 1, refresh_version: movedVersion })),
    );
    expect(await watermark()).toEqual({ watermark: baseWatermark, version: movedVersion });

    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    expect(await state()).toMatchObject([
      { activity_id: fixture.activityId, status: "missing", gps_refresh_version: movedVersion },
    ]);
  });

  it("loads only the 16 oldest dirty canonical activities in one publication", async () => {
    const fixtures = Array.from({ length: 17 }, (_, index) => {
      const order = 17 - index;
      return {
        activityId: activityId(order),
        watermark: `2026-10-11 10:${String(order).padStart(2, "0")}:00`,
      };
    });
    await seed(...fixtures);
    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 1 });
    expect(reads).toEqual(Array.from({ length: 16 }, (_, index) => activityId(index + 1)));
    expect(await state()).toHaveLength(16);

    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    expect(reads.at(-1)).toBe(activityId(17));
    expect(await state()).toHaveLength(17);
  });

  it("includes a late earlier import and hides a moved member before refreshing the index", async () => {
    const anchor = { activityId: activityId(10), startedAt: "2026-10-10 10:00:00" };
    const earlier = { activityId: activityId(1), startedAt: "2026-10-09 10:00:00.999999" };
    const key = { userId: firstOwner, anchorActivityId: anchor.activityId };
    await seed(anchor);
    await projectGhostTrackIndex(makeOwner());
    expect((await listGhostTrackCandidates(makeOwner().client, key)).candidates).toEqual([]);

    await seed(earlier);
    await projectGhostTrackIndex(makeOwner());
    expect((await listGhostTrackCandidates(makeOwner().client, key)).candidates).toMatchObject([
      { activityId: earlier.activityId, startedAt: "2026-10-09T10:00:00.999999Z" },
    ]);

    await insertSources([{ ...source(earlier), group_id: activityId(20), refresh_version: 2 }]);
    expect((await listGhostTrackCandidates(makeOwner().client, key)).candidates).toEqual([]);
    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    expect(await state()).toMatchObject([
      { activity_id: earlier.activityId, status: "missing" },
      { activity_id: anchor.activityId, status: "ready" },
    ]);
  });

  it("leaves new source evidence pending when source metadata changes after discovery", async () => {
    const fixture = { activityId: activityId(1) };
    await seed(fixture);
    const correction = async () => {
      await insertSources([{ ...source(fixture), canonical_type: "running", refresh_version: 2 }]);
    };
    expect(await projectGhostTrackIndex(makeOwner({ beforeTrackRead: correction }))).toEqual({
      pendingTracks: 1,
    });
    expect(await state()).toEqual([]);

    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    expect(await state()).toMatchObject([{ activity_id: fixture.activityId, sport: "running" }]);
  });

  it("rechecks GPS at insertion and at candidate read time", async () => {
    const anchor = { activityId: activityId(2) };
    const prior = { activityId: activityId(1), startedAt: "2026-10-09 10:00:00" };
    const key = { userId: firstOwner, anchorActivityId: anchor.activityId };
    const original = points(prior);
    await seed(anchor);
    await projectGhostTrackIndex(makeOwner());
    await insertSources([source(prior)]);
    await insertPoints(original);

    const advanceGps = async () => {
      await insertPoints(
        original.map((point) => ({ ...point, refresh_version: movedVersion, lng: -122.6 })),
      );
    };
    expect(await projectGhostTrackIndex(makeOwner({ beforeWrite: advanceGps }))).toEqual({
      pendingTracks: 1,
    });
    expect(await state()).toMatchObject([{ activity_id: anchor.activityId }]);

    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    expect((await listGhostTrackCandidates(makeOwner().client, key)).candidates).toEqual([]);
    await insertPoints(
      original.map((point) => ({
        ...point,
        refresh_version: String(BigInt(movedVersion) + 1n),
      })),
    );
    expect((await listGhostTrackCandidates(makeOwner().client, key)).candidates).toEqual([]);
    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    expect((await listGhostTrackCandidates(makeOwner().client, key)).candidates).toMatchObject([
      { activityId: prior.activityId },
    ]);
    await insertPoints(
      original.map((point) => ({
        ...point,
        refresh_version: String(BigInt(movedVersion) + 2n),
        is_deleted: 1,
      })),
    );
    expect((await listGhostTrackCandidates(makeOwner().client, key)).candidates).toEqual([]);
  });

  it("fences publication from inside the write and hides already-published tracks", async () => {
    const anchor = { activityId: activityId(2) };
    const prior = { activityId: activityId(1), startedAt: "2026-10-09 10:00:00" };
    await seed(anchor, prior);
    await projectGhostTrackIndex(makeOwner());
    const key = { userId: firstOwner, anchorActivityId: anchor.activityId };
    expect((await listGhostTrackCandidates(makeOwner().client, key)).candidates).toHaveLength(1);

    await seed({ activityId: activityId(3) });
    expect(
      await projectGhostTrackIndex(
        makeOwner({
          beforeWrite: async () => {
            await fence(firstOwner);
          },
        }),
      ),
    ).toEqual({
      pendingTracks: 0,
    });
    expect(await state()).toHaveLength(2);
    expect((await listGhostTrackCandidates(makeOwner().client, key)).candidates).toEqual([]);
  });

  it("bounds pages from newest to oldest, excluding wrong users, sports, places and dates", async () => {
    const anchor = { activityId: activityId(100) };
    const nearby = Array.from({ length: 26 }, (_, index) => ({
      activityId: activityId(index + 1),
      startedAt: "2026-10-09 10:00:00.000001",
    }));
    await seed(
      anchor,
      ...nearby,
      { activityId: activityId(27), startedAt: "2026-10-08 10:00:00" },
      { activityId: activityId(90), startedAt: "2026-10-09 12:00:00", positions: [[37.5, -120.5]] },
      { activityId: activityId(91), startedAt: "2026-10-09 12:00:00", userId: secondOwner },
      { activityId: activityId(92), startedAt: "2026-10-09 12:00:00", sport: "running" },
      { activityId: activityId(93), startedAt: "2026-10-10 12:00:00" },
    );
    for (let batch = 0; batch < 3; batch += 1) await projectGhostTrackIndex(makeOwner());
    reads.length = 0;
    const key = { userId: firstOwner, anchorActivityId: anchor.activityId };
    const firstPage = await listGhostTrackCandidates(makeOwner().client, key);
    expect(firstPage.historyCoverage).toBe("unverified");
    expect(firstPage.candidates.map((candidate) => candidate.activityId)).toEqual(
      Array.from({ length: 25 }, (_, index) => activityId(26 - index)),
    );
    expect(firstPage.nextCursor).toEqual({
      startedAt: "2026-10-09T10:00:00.000001Z",
      activityId: activityId(2),
    });
    if (!firstPage.nextCursor) throw new Error("The first candidate page must have a cursor");
    const secondPage = await listGhostTrackCandidates(makeOwner().client, {
      ...key,
      before: firstPage.nextCursor,
    });
    expect(secondPage.candidates.map((candidate) => candidate.activityId)).toEqual([
      activityId(1),
      activityId(27),
    ]);
    expect(secondPage.nextCursor).toBeNull();
    expect(reads).toEqual([]);

    const scopedKey = { ...key, candidateActivityIds: [activityId(1), activityId(27)] };
    expect(await listGhostTrackCandidates(makeOwner().client, scopedKey)).toEqual(secondPage);
    const emptyScope = { ...key, candidateActivityIds: [] };
    expect(await listGhostTrackCandidates(makeOwner().client, emptyScope)).toEqual({
      candidates: [],
      nextCursor: null,
      historyCoverage: "unverified",
    });

    // Invalidate all metadata on the first page without updating the index.
    // The second metadata page must remain reachable through the empty page.
    await insertSources(
      nearby.slice(1).map((fixture) => ({
        ...source(fixture),
        group_id: activityId(200),
        refresh_version: 2,
      })),
    );
    const stalePage = await listGhostTrackCandidates(makeOwner().client, key);
    expect(stalePage).toEqual({
      candidates: [],
      nextCursor: firstPage.nextCursor,
      historyCoverage: "unverified",
    });
    const afterStale = await listGhostTrackCandidates(makeOwner().client, {
      ...key,
      before: firstPage.nextCursor,
    });
    expect(afterStale).toEqual(secondPage);
    expect(reads).toEqual([]);
  });

  it("keeps dateline overlap on either side and leaves unknown bounds unverified", async () => {
    const anchor = {
      activityId: activityId(10),
      positions: [
        [37.5, 179.9999],
        [37.5005, -179.9999],
      ],
    } satisfies TrackFixture;
    const near = {
      activityId: activityId(1),
      positions: [[37.5009, -179.9998]],
    } satisfies TrackFixture;
    const far = { activityId: activityId(2), positions: [[37.5, 0]] } satisfies TrackFixture;
    const unknown = { activityId: activityId(3), positions: [[null, null]] } satisfies TrackFixture;
    await seed(
      anchor,
      ...[near, far, unknown].map((fixture) => ({
        ...fixture,
        startedAt: "2026-10-09 10:00:00",
      })),
    );
    expect(await projectGhostTrackIndex(makeOwner())).toEqual({ pendingTracks: 0 });
    const page = await listGhostTrackCandidates(makeOwner().client, {
      userId: firstOwner,
      anchorActivityId: anchor.activityId,
    });
    expect(page.candidates.map((candidate) => candidate.activityId)).toEqual([near.activityId]);
    expect(page.historyCoverage).toBe("unverified");
  });

  it("uses compact inventory for an over-limit source and keeps coverage unverified", async () => {
    const fixture = { activityId: activityId(1) };
    await insertSources([source(fixture)]);
    await clickhouse.command({
      query: scope(`INSERT INTO analytics.activity_ghost_location_sample
        (user_id, activity_id, member_activity_id, provider_id, recorded_at, recorded_date,
          source_metric_stream_id, lat, lng, refresh_version, source_refreshed_at, refreshed_at)
        SELECT {userId:UUID}, {activityId:UUID}, {memberId:UUID}, 'garmin',
          addMicroseconds(toDateTime64('2026-10-10 10:00:00', 6), number), toDate('2026-10-10'),
          generateUUIDv4(), 37.5, -122.5, {version:UInt64},
          toDateTime64({watermark:String}, 9, 'UTC'), toDateTime64({watermark:String}, 9, 'UTC')
        FROM numbers(${bulkPointCount})`),
      query_params: {
        userId: firstOwner,
        activityId: fixture.activityId,
        memberId: memberId(fixture.activityId),
        version: baseVersion,
        watermark: baseWatermark,
      },
    });
    const inventory: InventoryQuery[] = [];
    expect(await projectGhostTrackIndex(makeOwner({ inventory }))).toEqual({ pendingTracks: 0 });
    expect(inventory).toHaveLength(2);

    const priorTable = "activity_ghost_location_sample_prior";
    await createProjectedLocationTable(priorTable, "activity_location_sample.sql");
    await clickhouse.command({
      query: scope(`INSERT INTO analytics.${priorTable} SELECT *
        FROM analytics.activity_ghost_location_sample`),
    });
    const priorQueryIds: string[] = [];
    for (const query of inventory) {
      const queryId = randomUUID();
      priorQueryIds.push(queryId);
      const result = await clickhouse.query({
        ...query,
        query_id: queryId,
        query: scope(
          query.query.replaceAll(
            "analytics.activity_ghost_location_sample",
            `analytics.${priorTable}`,
          ),
        ),
      });
      await result.json();
    }
    await clickhouse.command({ query: "SYSTEM FLUSH LOGS" });
    const readStats = await clickhouse.query({
      query: `SELECT query_id, read_rows, projections FROM system.query_log
        WHERE query_id IN {queryIds:Array(String)} AND type = 'QueryFinish'`,
      query_params: { queryIds: [...inventory.map((query) => query.query_id), ...priorQueryIds] },
      format: "JSONEachRow",
    });
    const statsById = new Map(
      (
        await readStats.json<{
          query_id: string;
          read_rows: string | number;
          projections: string[];
        }>()
      ).map((row) => [row.query_id, row]),
    );
    const stats = {
      current: inventory.map((query) => statsById.get(query.query_id)),
      prior: priorQueryIds.map((queryId) => statsById.get(queryId)),
    };
    writeSync(1, `${JSON.stringify({ ghostInventory: stats })}\n`);
    for (const read of stats.prior) {
      expect(read?.projections).not.toContain(`${databaseName}.${priorTable}.${projectionName}`);
      expect(Number(read?.read_rows)).toBeGreaterThanOrEqual(bulkPointCount);
    }
    for (const read of stats.current) {
      expect(read?.projections).toContain(
        `${databaseName}.activity_ghost_location_sample.${projectionName}`,
      );
      expect(Number(read?.read_rows)).toBeLessThan(20);
    }
    expect(await state()).toMatchObject([
      {
        activity_id: fixture.activityId,
        status: "over-limit",
        member_activity_id: memberId(fixture.activityId),
        point_count: 20_001,
        min_lat: null,
        max_lat: null,
        min_lng: null,
        max_lng: null,
      },
    ]);
    expect(
      await listGhostTrackCandidates(makeOwner().client, {
        userId: firstOwner,
        anchorActivityId: fixture.activityId,
      }),
    ).toEqual({ candidates: [], nextCursor: null, historyCoverage: "unverified" });
  });
});
