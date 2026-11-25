import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { BLE_HEART_RATE_PROVIDER_ID } from "@dofek/providers/push-providers";
import { ghostSessionsCompareResponseSchema } from "@dofek/training/ghost-sessions";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createActivityLocationMemberChangeSql,
  createActivityLocationSampleSql,
  requireClickHouseUrl,
} from "../db/activity-payload-dbt-microbatch-test-helpers.ts";
import { createActivitySourceRecordsSql } from "../db/activity-payload-dbt-source-test-helpers.ts";
import { buildIncrementalDedupedSensorBaseTableStatements } from "../db/clickhouse-deduped-sensor.ts";
import { createMigration as createHistoryMigration } from "../db/clickhouse-migrations/0122_ghost_session_history.ts";
import { createMigration as createScalarAuditMigration } from "../db/clickhouse-migrations/0123_ghost_session_scalar_audit.ts";
import { createGhostSessionPageSql } from "../db/ghost-session-result-schema.ts";
import { createGhostTrackIndexSql } from "../db/ghost-track-index-schema.ts";
import type { AnalyticsQueryOwner } from "./analytics-query-owner.ts";
import {
  getGhostSessionHistoryProgress,
  runGhostSessionHistory,
} from "./ghost-session-history-runner.ts";
import { auditGhostSessionPage } from "./ghost-sessions-projector.ts";
import { projectGhostTrackIndex } from "./ghost-track-index.ts";

type PublicationOwner = Pick<AnalyticsQueryOwner, "client" | "assertActive">;

const userId = randomUUID();
const otherOwnerId = randomUUID();
const recordedAt = "2026-10-10 10:00:00.123456";
const sourceWatermark = "2026-10-11 10:00:00.123456789";
const pendingWatermark = "2026-10-12 10:00:00.123456789";
const sourceVersion = "1791712800123456789";
const degreesPerMeter = 180 / (Math.PI * 6_371_000);

function activityId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function memberId(id: string): string {
  return id.replace("00000000", "00000001");
}

interface Fixture {
  activityId: string;
  startedAt: string;
  userId: string;
  northMeters?: number;
}

const anchor = { activityId: activityId(100), startedAt: recordedAt, userId };
const older = { activityId: activityId(1), startedAt: "2026-10-08 10:00:00.123456", userId };
const key = { userId, activityId: anchor.activityId };

describe("Ghost Sessions background history publication", () => {
  const database = `ghost_runner_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;
  const scope = (sql: string) => sql.replaceAll(/(?:analytics|ingest)\./g, `${database}.`);
  const pageWrites: string[] = [];
  const gpsReads: string[] = [];

  function owner(
    beforePage?: (anchorActivityId: string) => Promise<void>,
    replacement?: {
      afterInsert: () => Promise<void>;
      receipt: (count: number) => void;
    },
  ): PublicationOwner {
    return {
      assertActive: async () => {},
      client: {
        query: async <Row extends object>(
          options: Parameters<PublicationOwner["client"]["query"]>[0],
        ) => {
          if (options.query_params?.pointFetchLimit)
            gpsReads.push(String(options.query_params.activityId));
          const result = await client.query({ ...options, query: scope(options.query) });
          return {
            json: async () => {
              const rows = await result.json<Row>();
              if (
                options.query_params?.previousVersion &&
                options.query.includes("SELECT payload_digest AS payloadDigest")
              )
                replacement?.receipt(rows.length);
              return rows;
            },
          };
        },
        command: async (options) => {
          const isReplacement =
            options.query.startsWith("INSERT INTO analytics.ghost_session_page") &&
            options.query_params?.previousVersion;
          if (options.query.startsWith("INSERT INTO analytics.ghost_session_page")) {
            const anchorActivityId = String(options.query_params?.activityId);
            pageWrites.push(anchorActivityId);
            await beforePage?.(anchorActivityId);
          }
          await client.command({ ...options, query: scope(options.query) });
          if (isReplacement) await replacement?.afterInsert();
        },
        insert: (options) => client.insert({ ...options, table: scope(options.table) }),
      },
    };
  }

  async function seed(fixture: Fixture, gps = true) {
    const member = memberId(fixture.activityId);
    const day = fixture.startedAt.slice(0, 10);
    await client.insert({
      table: `${database}.activity_source_records`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: member,
          group_id: fixture.activityId,
          user_id: fixture.userId,
          provider_id: "garmin",
          canonical_type: "cycling",
          modality: "road",
          started_at: fixture.startedAt,
          ended_at: `${day} 10:00:30.123456`,
          source_synced_at: sourceWatermark,
          refresh_version: 1,
        },
      ],
    });
    if (!gps) return;
    await client.insert({
      table: `${database}.activity_ghost_location_sample`,
      format: "JSONEachRow",
      values: Array.from({ length: 21 }, (_, index) => ({
        user_id: fixture.userId,
        activity_id: fixture.activityId,
        member_activity_id: member,
        provider_id: "garmin",
        device_id: "Direct",
        recorded_at: `${day} 10:00:${String(index).padStart(2, "0")}.123456`,
        recorded_date: day,
        source_metric_stream_id: randomUUID(),
        lat: (fixture.northMeters ?? 0) * degreesPerMeter,
        lng: index * 20 * degreesPerMeter,
        source_refreshed_at: sourceWatermark,
        refreshed_at: sourceWatermark,
        refresh_version: sourceVersion,
        is_deleted: 0,
      })),
    });
  }

  async function markPending(fixture: Fixture) {
    await client.insert({
      table: `${database}.activity_location_member_change`,
      format: "JSONEachRow",
      values: [
        {
          user_id: fixture.userId,
          member_activity_id: memberId(fixture.activityId),
          changed_at: pendingWatermark,
          has_live_sample: 1,
        },
      ],
    });
  }

  async function uploadHeartRate(
    fixture: Fixture,
    bpm: number,
    ids = Array.from({ length: 20 }, () => randomUUID()),
    version = 2,
  ) {
    const day = fixture.startedAt.slice(0, 10);
    await client.insert({
      table: `${database}.sensor_scalar_sample`,
      format: "JSONEachRow",
      values: ids.map((id, index) => ({
        id,
        user_id: fixture.userId,
        activity_id: null,
        member_activity_id: null,
        device_id: "Chest strap",
        provider_id: BLE_HEART_RATE_PROVIDER_ID,
        source_type: "ble",
        recorded_date: day,
        recorded_at: `${day} 10:00:${String(index).padStart(2, "0")}.123456`,
        channel: "heart_rate",
        scalar: bpm,
        provider_priority: 20,
        _peerdb_synced_at: pendingWatermark,
        _peerdb_version: version,
        _peerdb_is_deleted: 0,
      })),
    });
    return ids;
  }

  async function erase(pendingUserId: string) {
    await owner().client.command({
      query: `INSERT INTO ingest.account_erasure_fence (user_hash)
        SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
      query_params: { userId: pendingUserId },
    });
  }

  const tick = (runOwner = owner()) => runGhostSessionHistory(runOwner);
  const progress = (input = key) => getGhostSessionHistoryProgress(owner().client, input);

  async function anchorPages() {
    const result = await owner().client.query<{
      historyGeneration: string;
      requestCursor: string;
    }>({
      query: `SELECT history_generation AS historyGeneration, request_cursor AS requestCursor
        FROM analytics.ghost_session_page FINAL
        WHERE user_id = {userId:UUID} AND activity_id = {activityId:UUID}
        ORDER BY request_cursor`,
      query_params: key,
      format: "JSONEachRow",
    });
    return result.json();
  }

  async function visibleComparison() {
    const state = await progress();
    const result = await owner().client.query<{
      comparison: string;
      sectionId: string;
      passId: string;
    }>({
      query: `SELECT selected.comparison AS comparison, selected.section_id AS sectionId,
          selected.pass_id AS passId
        FROM analytics.ghost_session_page FINAL
        ARRAY JOIN matches AS selected
        WHERE user_id = {userId:UUID} AND activity_id = {activityId:UUID}
          AND anchor_generation = {anchorGeneration:Nullable(String)}
          AND history_generation = {historyGeneration:Nullable(String)}
          AND refresh_version <= {pointerVersion:UInt64}
          AND selected.candidate_activity_id = {candidate:UUID}`,
      query_params: {
        ...key,
        anchorGeneration: state?.anchorGeneration ?? null,
        historyGeneration: state?.historyGeneration ?? null,
        pointerVersion: state?.refreshVersion ?? "0",
        candidate: older.activityId,
      },
      format: "JSONEachRow",
    });
    const [match] = await result.json();
    if (!match) throw new Error("Expected a visible comparison");
    return {
      sectionId: match.sectionId,
      passId: match.passId,
      comparison: ghostSessionsCompareResponseSchema.parse(JSON.parse(match.comparison)),
    };
  }

  async function visibleInitialReceipt() {
    const state = await progress();
    if (!state?.finished || !state.anchorGeneration || !state.historyGeneration)
      throw new Error("Expected a finished history");
    const result = await owner().client.query<{ digest: string; version: string }>({
      query: `SELECT payload_digest AS digest, toString(refresh_version) AS version
        FROM analytics.ghost_session_page FINAL
        WHERE user_id = {userId:UUID} AND activity_id = {activityId:UUID}
          AND anchor_generation = {anchorGeneration:String}
          AND history_generation = {historyGeneration:String} AND request_cursor = ''
          AND refresh_version <= {pointerVersion:UInt64}`,
      query_params: {
        ...key,
        anchorGeneration: state.anchorGeneration,
        historyGeneration: state.historyGeneration,
        pointerVersion: state.refreshVersion,
      },
      format: "JSONEachRow",
    });
    return (await result.json())[0];
  }

  const cursor = { activityId: activityId(2), startedAt: "2026-10-08T10:00:00.123456Z" };

  async function prepareOpenAnchor() {
    await seed(anchor);
    await tick();
    expect(await progress()).toMatchObject({ historyCoverage: "complete" });

    for (let index = 1; index <= 26; index += 1)
      await seed({ ...older, activityId: activityId(index), northMeters: 175 });
    await projectGhostTrackIndex(owner());
    await projectGhostTrackIndex(owner());
    await tick();
    const open = await progress();
    expect(open).toMatchObject({
      sourceHistoryCoverage: "complete",
      historyCoverage: "partial",
      finished: false,
      nextCursor: cursor,
    });
    expect(await anchorPages()).toEqual([
      { historyGeneration: open?.historyGeneration, requestCursor: "" },
    ]);
    return open;
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
      `CREATE TABLE ${database}.account_erasure_fence (user_hash String)
        ENGINE = ReplacingMergeTree ORDER BY user_hash`,
      ...buildIncrementalDedupedSensorBaseTableStatements(),
      createGhostTrackIndexSql,
      createGhostSessionPageSql,
      ...(createHistoryMigration().statements ?? []),
      ...(createScalarAuditMigration().statements ?? []),
    ])
      await client.command({ query: scope(query) });
  });

  beforeEach(async () => {
    pageWrites.length = 0;
    gpsReads.length = 0;
    for (const table of [
      "activity_source_records",
      "activity_ghost_location_sample",
      "activity_location_member_change",
      "ghost_track",
      "account_erasure_fence",
      "ghost_session_page",
      "ghost_session_history",
      "sensor_scalar_sample",
    ])
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("publishes complete empty history and revisits it without another comparison page", async () => {
    await seed(anchor);
    await tick();
    const initial = await progress();
    expect(initial).toMatchObject({
      anchorStatus: "ready",
      historyGeneration: expect.any(String),
      sourceHistoryCoverage: "complete",
      historyCoverage: "complete",
      finished: true,
      nextCursor: null,
    });
    expect(await anchorPages()).toHaveLength(1);
    pageWrites.length = 0;
    await tick();
    expect(pageWrites).toEqual([]);
    expect(await progress()).toMatchObject({ historyGeneration: initial?.historyGeneration });
  });

  it("restarts a complete generation after a backdated source import", async () => {
    await seed(anchor);
    await tick();
    const initial = await progress();
    expect(initial).toMatchObject({ finished: true, historyCoverage: "complete" });

    await seed(older);
    await tick();
    const replacement = await progress();
    expect(replacement).toMatchObject({ finished: true, historyCoverage: "complete" });
    expect(replacement?.historyGeneration).not.toBe(initial?.historyGeneration);
    expect(await anchorPages()).toEqual([
      { historyGeneration: replacement?.historyGeneration, requestCursor: "" },
    ]);
  });

  it("refreshes a finished page after independent standalone heart rate arrives", async () => {
    await seed(anchor);
    await seed(older);
    await tick();
    const initial = await progress();
    expect(initial).toMatchObject({ finished: true, historyCoverage: "complete" });
    expect((await visibleComparison()).comparison.metrics.heartRateBpm).toBeNull();

    await uploadHeartRate(anchor, 138);
    await uploadHeartRate(older, 144);
    pageWrites.length = 0;
    await tick();

    expect((await visibleComparison()).comparison.metrics.heartRateBpm).toEqual({
      anchor: 138,
      candidate: 144,
    });
    expect(pageWrites).toEqual([anchor.activityId]);
    expect(await progress()).toMatchObject({
      historyGeneration: initial?.historyGeneration,
      historyCoverage: "complete",
      finished: true,
      nextCursor: null,
    });
    expect(await anchorPages()).toEqual([
      { historyGeneration: initial?.historyGeneration, requestCursor: "" },
    ]);
  });

  it("atomically accepts a scalar-only revision inside the finished serving frontier", async () => {
    await seed(anchor);
    await seed(older);
    await tick();
    const accepted = await visibleInitialReceipt();
    const timing = await visibleComparison();
    if (!accepted) throw new Error("Expected an accepted receipt");

    const heartRateIds = await uploadHeartRate(anchor, 138);
    await uploadHeartRate(older, 144);
    const receipts: number[] = [];
    gpsReads.length = 0;
    let visibleBeforeProgress: Awaited<ReturnType<typeof visibleInitialReceipt>>;
    await tick(
      owner(undefined, {
        afterInsert: async () => {
          visibleBeforeProgress = await visibleInitialReceipt();
          await uploadHeartRate(anchor, 151, heartRateIds, 3);
        },
        receipt: (count) => receipts.push(count),
      }),
    );

    expect(receipts).toEqual([1]);
    expect(visibleBeforeProgress).toEqual({
      digest: expect.any(String),
      version: (BigInt(accepted.version) + 1n).toString(),
    });
    expect(visibleBeforeProgress?.digest).not.toBe(accepted.digest);
    expect(await visibleInitialReceipt()).toEqual(visibleBeforeProgress);
    expect(gpsReads).toEqual([]);
    expect(await visibleComparison()).toEqual({
      ...timing,
      comparison: {
        ...timing.comparison,
        metrics: {
          ...timing.comparison.metrics,
          heartRateBpm: { anchor: 138, candidate: 144 },
        },
      },
    });
    const state = await progress();
    if (!state?.anchorGeneration || !state.historyGeneration)
      throw new Error("Expected a finished history");
    expect(
      await auditGhostSessionPage(owner().client, {
        ...key,
        anchorGeneration: state.anchorGeneration,
        historyGeneration: state.historyGeneration,
      }),
    ).toMatchObject({ changed: true });
    await tick();
    expect((await visibleComparison()).comparison.metrics.heartRateBpm).toEqual({
      anchor: 151,
      candidate: 144,
    });
    expect(gpsReads).toEqual([]);
  });

  it("retains the exact accepted receipt when scalars change before the audit insert", async () => {
    await seed(anchor);
    await seed(older);
    await tick();
    const accepted = await visibleInitialReceipt();
    expect(accepted).toBeDefined();
    const heartRateIds = await uploadHeartRate(anchor, 138);
    await uploadHeartRate(older, 144);
    const receipts: number[] = [];
    await tick(
      owner(
        async (activityId) => {
          if (activityId === anchor.activityId) await uploadHeartRate(anchor, 151, heartRateIds, 3);
        },
        {
          afterInsert: async () => {},
          receipt: (count) => receipts.push(count),
        },
      ),
    );
    expect(receipts).toEqual([0]);
    expect(await visibleInitialReceipt()).toEqual(accepted);
  });

  it("leaves the page in place until a checked-time touch gives the audit a version", async () => {
    await seed(anchor);
    await seed(older);
    await tick();
    const accepted = await visibleInitialReceipt();
    if (!accepted) throw new Error("Expected an accepted receipt");

    const result = await owner().client.query<{ activity_id: string; refresh_version: string }>({
      query: `SELECT * REPLACE(toString(refresh_version) AS refresh_version)
        FROM analytics.ghost_session_history FINAL WHERE user_id = {userId:UUID}`,
      query_params: { userId },
      format: "JSONEachRow",
    });
    const states = await result.json();
    await client.command({ query: `TRUNCATE TABLE ${database}.ghost_session_history` });
    await owner().client.insert({
      table: "analytics.ghost_session_history",
      format: "JSONEachRow",
      values: states.map((state) =>
        state.activity_id === anchor.activityId
          ? { ...state, refresh_version: accepted.version }
          : state,
      ),
    });
    expect((await progress())?.refreshVersion).toBe(accepted.version);

    await uploadHeartRate(anchor, 138);
    await uploadHeartRate(older, 144);
    pageWrites.length = 0;
    await tick();

    expect(pageWrites).toEqual([]);
    expect(await visibleInitialReceipt()).toEqual(accepted);
    const touched = await progress();
    expect(BigInt(touched?.refreshVersion ?? "0")).toBeGreaterThan(BigInt(accepted.version));

    await tick();
    expect(await visibleInitialReceipt()).toMatchObject({
      version: (BigInt(accepted.version) + 1n).toString(),
    });
    expect((await visibleComparison()).comparison.metrics.heartRateBpm).toEqual({
      anchor: 138,
      candidate: 144,
    });
  });

  it("saves one page per tick and finishes only after following the saved keyset", async () => {
    const open = await prepareOpenAnchor();
    // Other anchors may be checked first. The saved page must remain readable until this anchor's turn.
    for (let attempt = 0; attempt < 3 && (await anchorPages()).length === 1; attempt += 1)
      await tick();
    expect(await progress()).toMatchObject({
      historyGeneration: open?.historyGeneration,
      historyCoverage: "complete",
      finished: true,
      nextCursor: null,
    });
    expect(await anchorPages()).toEqual([
      { historyGeneration: open?.historyGeneration, requestCursor: "" },
      {
        historyGeneration: open?.historyGeneration,
        requestCursor: JSON.stringify([cursor.startedAt, cursor.activityId]),
      },
    ]);

    const finished = await progress();
    if (!finished?.anchorGeneration || !finished.historyGeneration)
      throw new Error("Expected a complete generation to audit");
    const auditedKey = {
      ...key,
      anchorGeneration: finished.anchorGeneration,
      historyGeneration: finished.historyGeneration,
    };
    expect(await auditGhostSessionPage(owner().client, auditedKey)).toMatchObject({
      nextCursor: JSON.stringify([cursor.startedAt, cursor.activityId]),
      changed: false,
    });
    expect(
      await auditGhostSessionPage(owner().client, { ...auditedKey, before: cursor }),
    ).toMatchObject({ nextCursor: null, changed: false });
  });

  it("drops a failed continuation while preserving the referenced first page and cursor", async () => {
    const open = await prepareOpenAnchor();
    pageWrites.length = 0;
    const racingOwner = owner(async (anchorActivityId) => {
      if (anchorActivityId === anchor.activityId) await markPending(older);
    });
    for (let attempt = 0; attempt < 3 && !pageWrites.includes(anchor.activityId); attempt += 1)
      await tick(racingOwner);

    expect(pageWrites).toContain(anchor.activityId);
    expect(await progress()).toMatchObject({
      historyGeneration: open?.historyGeneration,
      historyCoverage: "partial",
      finished: false,
      nextCursor: cursor,
    });
    expect(await anchorPages()).toEqual([
      { historyGeneration: open?.historyGeneration, requestCursor: "" },
    ]);
  });

  it("keeps current comparisons partial while an earlier source is pending", async () => {
    await seed(anchor);
    await seed(older, false);
    await markPending(older);
    await tick();
    expect(await progress()).toMatchObject({
      anchorStatus: "ready",
      sourceHistoryCoverage: "partial",
      historyCoverage: "partial",
      finished: true,
    });
    expect(await anchorPages()).toHaveLength(1);
  });

  it("keeps the old page when current history changes during replacement publication", async () => {
    await seed(anchor);
    await tick();
    const initial = await progress();
    expect(initial).toMatchObject({ historyCoverage: "complete" });

    await seed(older);
    await tick(
      owner(async (anchorActivityId) => {
        if (anchorActivityId === anchor.activityId) await markPending(older);
      }),
    );
    expect(await progress()).toMatchObject({
      historyGeneration: initial?.historyGeneration,
      historyCoverage: "partial",
    });
    expect(await anchorPages()).toEqual([
      { historyGeneration: initial?.historyGeneration, requestCursor: "" },
    ]);
  });

  it("fences the owned state and result page when the account is erased during publication", async () => {
    await seed(anchor);
    await tick(owner(() => erase(userId)));
    expect(await progress()).toBeNull();
    expect(await anchorPages()).toEqual([]);
    expect(pageWrites).toEqual([anchor.activityId]);
    expect(await progress({ ...key, userId: otherOwnerId })).toBeNull();
  });
});
