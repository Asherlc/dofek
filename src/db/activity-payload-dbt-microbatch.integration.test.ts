import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import * as activityPayloadTest from "./activity-payload-dbt-microbatch-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const userId = "00000000-0000-0000-0000-000000001001";
const oldGroupId = "00000000-0000-0000-0000-000000001010";
const newGroupId = "00000000-0000-0000-0000-000000001011";
const unrelatedGroupId = "00000000-0000-0000-0000-000000001012";
const routeGroupId = "00000000-0000-0000-0000-000000001030";
const unrelatedRouteGroupId = "00000000-0000-0000-0000-000000001031";
const routeMemberId = "00000000-0000-0000-0000-000000001032";
const unrelatedRouteMemberId = "00000000-0000-0000-0000-000000001033";
const movedRouteGroupId = "00000000-0000-0000-0000-000000001034";
const tombstoneOnlyGroupId = "00000000-0000-0000-0000-000000001036";
const productionSliceGroupId = "00000000-0000-0000-0000-000000001038";
const productionSliceMemberId = "00000000-0000-0000-0000-000000001039";
const productionSliceProviderBMemberId = "00000000-0000-0000-0000-000000001048";
const productionSliceRemappedGroupId = "00000000-0000-0000-0000-000000001049";
const productionRestoreGroupId = "00000000-0000-0000-0000-000000001050";
const productionRestoreMemberId = "00000000-0000-0000-0000-000000001051";
const productionProvenanceGroupId = "00000000-0000-0000-0000-000000001053";
const productionProvenanceLowerMemberId = "00000000-0000-0000-0000-000000000001";
const providerAPointIds = [
  "00000000-0000-0000-0000-000000001040",
  "00000000-0000-0000-0000-000000001041",
  "00000000-0000-0000-0000-000000001042",
] as const;
const providerBPointIds = [
  "00000000-0000-0000-0000-000000001043",
  "00000000-0000-0000-0000-000000001044",
  "00000000-0000-0000-0000-000000001045",
  "00000000-0000-0000-0000-000000001046",
] as const;
const unrelatedPointId = "00000000-0000-0000-0000-000000001047";
const untrackedRouteMemberId = "00000000-0000-0000-0000-000000009999";

const queryStatsSchema = z.array(
  z.object({
    query_duration_ms: z.coerce.number(),
    read_rows: z.coerce.number(),
  }),
);

describe("activity payload dbt batch reconciliation", () => {
  let client: ClickHouseClient;
  let artifactDirectory: string;
  const database = `activity_payload_batch_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    const clickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
    if (!clickHouseUrl) {
      throw new Error("CLICKHOUSE_URL is required for activity payload integration tests");
    }
    client = createClient({ url: clickHouseUrl, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    artifactDirectory = await mkdtemp(join(tmpdir(), "activity-payload-dbt-"));
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
    if (artifactDirectory) {
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });

  it("reconciles only replayed sensor keys across dbt microbatches and group moves", async () => {
    await activityPayloadTest.seedSensorFixture(client, database);

    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_sensor_sample", "activity_sensor_summary_rows"],
      "2026-09-04",
      "2026-09-05",
    );
    await activityPayloadTest.expectSensorState(
      client,
      database,
      [{ activity_id: oldGroupId, scalar: 100, is_deleted: 0 }],
      [
        { activity_id: oldGroupId, avg_hr: 100, sample_count: 1, is_deleted: 0 },
        { activity_id: unrelatedGroupId, avg_hr: null, sample_count: 0, is_deleted: 1 },
      ],
    );

    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_sensor_sample", "activity_sensor_summary_rows"],
      "2026-09-05",
      "2026-09-06",
    );
    await activityPayloadTest.expectSensorState(
      client,
      database,
      [
        { activity_id: oldGroupId, scalar: 100, is_deleted: 0 },
        { activity_id: unrelatedGroupId, scalar: 120, is_deleted: 0 },
      ],
      [
        { activity_id: oldGroupId, avg_hr: 100, sample_count: 1, is_deleted: 0 },
        { activity_id: unrelatedGroupId, avg_hr: 120, sample_count: 1, is_deleted: 0 },
      ],
    );

    await activityPayloadTest.moveMemberAndReplaySensor(client, database);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_sensor_sample", "activity_sensor_summary_rows"],
      "2026-09-06",
      "2026-09-07",
    );
    await activityPayloadTest.expectSensorState(
      client,
      database,
      [
        { activity_id: oldGroupId, scalar: 100, is_deleted: 1 },
        { activity_id: newGroupId, scalar: 100, is_deleted: 0 },
        { activity_id: unrelatedGroupId, scalar: 120, is_deleted: 0 },
      ],
      [
        { activity_id: oldGroupId, avg_hr: null, sample_count: 0, is_deleted: 1 },
        { activity_id: newGroupId, avg_hr: 100, sample_count: 1, is_deleted: 0 },
        { activity_id: unrelatedGroupId, avg_hr: 120, sample_count: 1, is_deleted: 0 },
      ],
    );

    const compiledSql = await readFile(
      join(
        artifactDirectory,
        "run",
        "dofek_analytics",
        "models",
        "read_models",
        "activity_sensor_sample",
        "activity_sensor_sample_2026-09-06.sql",
      ),
      "utf8",
    );
    expect(compiledSql).toContain("where refreshed_at >= '2026-09-06 00:00:00'");
    expect(compiledSql).toContain("and refreshed_at < '2026-09-07 00:00:00'");
    expect(compiledSql).toContain("INNER JOIN batch_sample_keys");
  }, 240_000);

  it("preserves unrelated routes, switches providers, and remaps routes across groups", async () => {
    await activityPayloadTest.seedLocationFixture(client, database);

    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        providerAPointIds[0],
        "provider-a",
        -122.3,
        37.8,
        "2026-09-03 10:10:00",
        "2026-09-03 12:00:00",
      ],
      [
        providerAPointIds[1],
        "provider-a",
        -122.29,
        37.81,
        "2026-09-03 10:20:00",
        "2026-09-03 12:00:00",
      ],
      [
        providerAPointIds[2],
        "provider-a",
        -122.28,
        37.82,
        "2026-09-03 10:30:00",
        "2026-09-03 12:00:00",
      ],
    ]);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows", "activity_stream_points"],
      "2026-09-03",
      "2026-09-04",
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      routeGroupId,
      providerAPointIds,
    );
    await activityPayloadTest.expectLocationCentroid(
      client,
      database,
      routeGroupId,
      37.81,
      -122.29,
    );

    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        unrelatedPointId,
        "provider-z",
        -121.9,
        37.4,
        "2026-09-04 10:10:00",
        "2026-09-04 12:00:00",
        unrelatedRouteMemberId,
      ],
    ]);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows"],
      "2026-09-04",
      "2026-09-05",
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      routeGroupId,
      providerAPointIds,
    );
    await activityPayloadTest.expectLocationCentroid(
      client,
      database,
      routeGroupId,
      37.81,
      -122.29,
    );

    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        providerBPointIds[0],
        "provider-b",
        -122.1,
        37.9,
        "2026-09-03 10:10:00",
        "2026-09-05 12:00:00",
      ],
      [
        providerBPointIds[1],
        "provider-b",
        -122.09,
        37.91,
        "2026-09-03 10:20:00",
        "2026-09-05 12:00:00",
      ],
    ]);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows"],
      "2026-09-05",
      "2026-09-06",
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      routeGroupId,
      providerAPointIds,
    );
    await activityPayloadTest.expectLocationCentroid(
      client,
      database,
      routeGroupId,
      37.81,
      -122.29,
    );

    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        providerBPointIds[2],
        "provider-b",
        -122.08,
        37.92,
        "2026-09-03 10:30:00",
        "2026-09-06 12:00:00",
      ],
      [
        providerBPointIds[3],
        "provider-b",
        -122.07,
        37.93,
        "2026-09-03 10:40:00",
        "2026-09-06 12:00:00",
      ],
    ]);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows", "activity_stream_points"],
      "2026-09-06",
      "2026-09-07",
    );

    const pointResult = await client.query({
      query: `SELECT toString(source_metric_stream_id) AS source_metric_stream_id, is_deleted
        FROM ${database}.activity_location_sample FINAL
        WHERE activity_id = toUUID('${routeGroupId}')
        ORDER BY source_metric_stream_id`,
      format: "JSONEachRow",
    });
    expect(await pointResult.json()).toEqual([
      ...providerAPointIds.map((source_metric_stream_id) => ({
        source_metric_stream_id,
        is_deleted: 1,
      })),
      ...providerBPointIds.map((source_metric_stream_id) => ({
        source_metric_stream_id,
        is_deleted: 0,
      })),
    ]);
    await activityPayloadTest.expectLocationCentroid(
      client,
      database,
      routeGroupId,
      37.915,
      -122.085,
    );
    const unchangedStreamVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      unrelatedRouteGroupId,
    );

    await activityPayloadTest.moveRouteMember(client, database);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows"],
      "2026-09-07",
      "2026-09-08",
    );

    const movedPointResult = await client.query({
      query: `SELECT toString(activity_id) AS activity_id,
          toString(source_metric_stream_id) AS source_metric_stream_id,
          is_deleted
        FROM ${database}.activity_location_sample FINAL
        WHERE toString(source_metric_stream_id) IN (${providerBPointIds
          .map((id) => `'${id}'`)
          .join(",")})
        ORDER BY activity_id, source_metric_stream_id`,
      format: "JSONEachRow",
    });
    expect(await movedPointResult.json()).toEqual([
      ...providerBPointIds.map((source_metric_stream_id) => ({
        activity_id: routeGroupId,
        source_metric_stream_id,
        is_deleted: 1,
      })),
      ...providerBPointIds.map((source_metric_stream_id) => ({
        activity_id: movedRouteGroupId,
        source_metric_stream_id,
        is_deleted: 0,
      })),
    ]);
    const pairedRefreshResult = await client.query({
      query: `SELECT toString(source_metric_stream_id) AS source_metric_stream_id,
          toUInt32(count()) AS mapping_count,
          toUInt32(uniqExact(refresh_version)) AS refresh_clock_count
        FROM ${database}.activity_location_sample FINAL
        WHERE toString(source_metric_stream_id) IN (${providerBPointIds
          .map((id) => `'${id}'`)
          .join(",")})
        GROUP BY source_metric_stream_id
        ORDER BY source_metric_stream_id`,
      format: "JSONEachRow",
    });
    expect(await pairedRefreshResult.json()).toEqual(
      providerBPointIds.map((source_metric_stream_id) => ({
        source_metric_stream_id,
        mapping_count: 2,
        refresh_clock_count: 1,
      })),
    );
    await activityPayloadTest.expectHistoricalLocationMappingsNewerThanStream(client, database);
    await activityPayloadTest.expectActiveLocationPointIds(client, database, routeGroupId, []);
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      movedRouteGroupId,
      providerBPointIds,
    );
    await activityPayloadTest.expectNoActiveLocationSummary(client, database, routeGroupId);
    await activityPayloadTest.expectLocationCentroid(
      client,
      database,
      movedRouteGroupId,
      37.915,
      -122.085,
    );

    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    await activityPayloadTest.expectLocationStreamState(client, database, [
      { activity_id: routeGroupId, point_count: 0, is_deleted: 1 },
      { activity_id: movedRouteGroupId, point_count: 4, is_deleted: 0 },
    ]);
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, unrelatedRouteGroupId),
    ).toBe(unchangedStreamVersion);

    const unchangedLocationVersion = await activityPayloadTest.getLocationSampleVersion(
      client,
      database,
      movedRouteGroupId,
    );
    await activityPayloadTest.setRouteGroupDeleted(client, database, true);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    await activityPayloadTest.expectLocationStreamState(client, database, [
      { activity_id: routeGroupId, point_count: 0, is_deleted: 1 },
      { activity_id: movedRouteGroupId, point_count: 0, is_deleted: 1 },
    ]);
    const deletedStreamVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      movedRouteGroupId,
    );
    await activityPayloadTest.seedTombstoneOnlyCurrentGroup(client, database);
    const tombstoneOnlyPriorVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      tombstoneOnlyGroupId,
    );

    await activityPayloadTest.setRouteGroupDeleted(client, database, false);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    await activityPayloadTest.expectLocationStreamState(client, database, [
      { activity_id: routeGroupId, point_count: 0, is_deleted: 1 },
      { activity_id: movedRouteGroupId, point_count: 4, is_deleted: 0 },
    ]);
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, movedRouteGroupId),
    ).not.toBe(deletedStreamVersion);
    expect(
      await activityPayloadTest.getLocationSampleVersion(client, database, movedRouteGroupId),
    ).toBe(unchangedLocationVersion);
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, tombstoneOnlyGroupId),
    ).not.toBe(tombstoneOnlyPriorVersion);
    await activityPayloadTest.expectDeletedLocationStream(client, database, tombstoneOnlyGroupId);
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, unrelatedRouteGroupId),
    ).toBe(unchangedStreamVersion);

    const processedTombstoneVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      tombstoneOnlyGroupId,
    );
    const processedTombstoneTransitionCount = await activityPayloadTest.getStreamTransitionCount(
      client,
      database,
      tombstoneOnlyGroupId,
    );
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, tombstoneOnlyGroupId),
    ).toBe(processedTombstoneVersion);
    expect(
      await activityPayloadTest.getStreamTransitionCount(client, database, tombstoneOnlyGroupId),
    ).toBe(processedTombstoneTransitionCount);
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, unrelatedRouteGroupId),
    ).toBe(unchangedStreamVersion);

    const priorOldGroupStreamVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      routeGroupId,
    );
    const priorMovedGroupStreamVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      movedRouteGroupId,
    );
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
      [routeMemberId, routeGroupId],
    );
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, routeGroupId),
    ).not.toBe(priorOldGroupStreamVersion);
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, movedRouteGroupId),
    ).not.toBe(priorMovedGroupStreamVersion);
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, unrelatedRouteGroupId),
    ).toBe(unchangedStreamVersion);

    const compiledSql = await readFile(
      join(
        artifactDirectory,
        "run",
        "dofek_analytics",
        "models",
        "read_models",
        "activity_location_sample.sql",
      ),
      "utf8",
    );
    expect(compiledSql).toContain("affected_groups AS MATERIALIZED");
    expect(compiledSql).not.toContain("where ingested_at >= '2026-09-06 00:00:00'");
  }, 240_000);

  it("bounds incremental location reconciliation to affected member histories", async () => {
    await activityPayloadTest.seedLocationFixture(client, database);
    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        providerAPointIds[0],
        "provider-a",
        -122.3,
        37.8,
        "2026-09-03 10:10:00",
        "2026-09-03 12:00:00",
      ],
    ]);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample"],
      "2026-09-03",
      "2026-09-04",
    );

    const unrelatedRowCount = 10_000;
    await client.command({
      query: `INSERT INTO ${database}.metric_stream
        (id, activity_id, user_id, recorded_at, provider_id, channel, point,
         ingested_at, version, is_deleted)
        SELECT generateUUIDv4(), toUUID('${untrackedRouteMemberId}'), toUUID('${userId}'),
          addMilliseconds(toDateTime64('2026-09-02 10:00:00', 9, 'UTC'), number),
          'provider-z', 'location', tuple(-121.9, 37.4),
          toDateTime64('2026-09-02 12:00:00', 9, 'UTC'), 1, 0
        FROM numbers(${unrelatedRowCount})`,
    });
    const startedAt = new Date().toISOString();
    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        providerAPointIds[1],
        "provider-a",
        -122.29,
        37.81,
        "2026-09-03 10:20:00",
        "2026-09-05 12:00:00",
      ],
    ]);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample"],
      "2026-09-05",
      "2026-09-06",
    );
    await client.command({ query: "SYSTEM FLUSH LOGS" });

    const result = await client.query({
      query: `SELECT read_rows, query_duration_ms
        FROM system.query_log
        WHERE type = 'QueryFinish'
          AND query_kind = 'Insert'
          AND query_start_time_microseconds >= parseDateTime64BestEffort({startedAt:String})
          AND position(query, concat('insert into \`', {database:String},
            '\`.\`activity_location_sample\`')) > 0
        ORDER BY query_start_time_microseconds DESC
        LIMIT 1`,
      query_params: { database, startedAt },
      format: "JSONEachRow",
    });
    const [queryStats] = queryStatsSchema.parse(await result.json());

    expect(queryStats).toBeDefined();
    expect(queryStats?.read_rows).toBeLessThan(unrelatedRowCount * 4);
    await activityPayloadTest.expectActiveLocationPointIds(client, database, routeGroupId, [
      providerAPointIds[0],
      providerAPointIds[1],
    ]);
  }, 240_000);

  it("does not append payload-free tombstones across an unchanged production dependency slice", async () => {
    await activityPayloadTest.seedProductionLifecycleSliceFixture(client, database);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["deduped_activities"],
      "2026-09-07",
      "2026-09-08",
    );
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    await activityPayloadTest.expectDeletedLocationStream(client, database, productionSliceGroupId);
    const initialProvenanceState = await activityPayloadTest.getDedupedActivityState(
      client,
      database,
      productionProvenanceGroupId,
    );
    expect(initialProvenanceState).toMatchObject({
      primary_activity_id: productionProvenanceLowerMemberId,
      notes: "code-unit-lower notes",
      raw: '{"source":"code-unit-lower"}',
    });
    const initialProvenanceHistory = await activityPayloadTest.getDedupedActivityHistory(
      client,
      database,
      productionProvenanceGroupId,
    );
    const initialProvenanceStreamVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      productionProvenanceGroupId,
    );
    const initialProvenanceStreamTransitions = await activityPayloadTest.getStreamTransitionCount(
      client,
      database,
      productionProvenanceGroupId,
    );
    const initialActivityVersion = await activityPayloadTest.getDedupedActivityVersion(
      client,
      database,
      productionSliceGroupId,
    );
    const initialActivityHistory = await activityPayloadTest.getDedupedActivityHistory(
      client,
      database,
      productionSliceGroupId,
    );
    const initialStreamVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      productionSliceGroupId,
    );
    const initialTransitionCount = await activityPayloadTest.getStreamTransitionCount(
      client,
      database,
      productionSliceGroupId,
    );

    await activityPayloadTest.rebuildEqualPriorityProvenanceInputs(client, database);
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["deduped_activities", "activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );

    const rebuiltActivityVersion = await activityPayloadTest.getDedupedActivityVersion(
      client,
      database,
      productionSliceGroupId,
    );
    expect(
      await activityPayloadTest.getLocationStreamVersion(client, database, productionSliceGroupId),
      `unchanged deduped activity version moved from ${initialActivityVersion} to ${rebuiltActivityVersion}`,
    ).toBe(initialStreamVersion);
    expect(
      await activityPayloadTest.getStreamTransitionCount(client, database, productionSliceGroupId),
    ).toBe(initialTransitionCount);
    expect(rebuiltActivityVersion).toBe(initialActivityVersion);
    expect(
      await activityPayloadTest.getDedupedActivityHistory(client, database, productionSliceGroupId),
    ).toEqual(initialActivityHistory);
    expect(
      await activityPayloadTest.getDedupedActivityState(
        client,
        database,
        productionProvenanceGroupId,
      ),
    ).toEqual(initialProvenanceState);
    expect(
      await activityPayloadTest.getDedupedActivityHistory(
        client,
        database,
        productionProvenanceGroupId,
      ),
    ).toEqual(initialProvenanceHistory);
    expect(
      await activityPayloadTest.getLocationStreamVersion(
        client,
        database,
        productionProvenanceGroupId,
      ),
    ).toBe(initialProvenanceStreamVersion);
    expect(
      await activityPayloadTest.getStreamTransitionCount(
        client,
        database,
        productionProvenanceGroupId,
      ),
    ).toBe(initialProvenanceStreamTransitions);

    await activityPayloadTest.changeActivitySourceRecord(
      client,
      database,
      productionSliceProviderBMemberId,
      {
        priority: 5,
      },
    );
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["deduped_activities", "activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    const priorityActivityState = await activityPayloadTest.getDedupedActivityState(
      client,
      database,
      productionSliceGroupId,
    );
    expect(priorityActivityState.primary_activity_id).toBe(productionSliceProviderBMemberId);
    expect(BigInt(priorityActivityState.refresh_version)).toBeGreaterThan(
      BigInt(rebuiltActivityVersion),
    );

    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor
        (user_id, recorded_at, channel, source_activity_id, refresh_version, is_deleted) VALUES
        ('${userId}', toDateTime64('2026-09-07 10:30:00', 9, 'UTC'), 'heart_rate',
         '${productionSliceMemberId}', 1, 0)`,
    });
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["deduped_activities", "activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    const sensorActivityState = await activityPayloadTest.getDedupedActivityState(
      client,
      database,
      productionSliceGroupId,
    );
    expect(sensorActivityState.primary_activity_id).toBe(productionSliceMemberId);
    expect(BigInt(sensorActivityState.refresh_version)).toBeGreaterThan(
      BigInt(priorityActivityState.refresh_version),
    );

    const preRemapStreamVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      productionSliceGroupId,
    );
    await activityPayloadTest.changeActivitySourceRecord(
      client,
      database,
      productionSliceProviderBMemberId,
      {
        groupId: productionSliceRemappedGroupId,
      },
    );
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["deduped_activities", "activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    const remappedActivityState = await activityPayloadTest.getDedupedActivityState(
      client,
      database,
      productionSliceGroupId,
    );
    expect(remappedActivityState.member_activity_ids).toEqual([productionSliceMemberId]);
    expect(BigInt(remappedActivityState.refresh_version)).toBeGreaterThan(
      BigInt(sensorActivityState.refresh_version),
    );
    expect(
      BigInt(
        await activityPayloadTest.getLocationStreamVersion(
          client,
          database,
          productionSliceGroupId,
        ),
      ),
    ).toBeGreaterThan(BigInt(preRemapStreamVersion));

    await activityPayloadTest.changeActivitySourceRecord(
      client,
      database,
      productionRestoreMemberId,
      {
        isDeleted: true,
      },
    );
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["deduped_activities", "activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    await activityPayloadTest.expectDeletedLocationStream(
      client,
      database,
      productionRestoreGroupId,
    );
    const deletedActivityVersion = await activityPayloadTest.getDedupedActivityVersion(
      client,
      database,
      productionRestoreGroupId,
    );
    const deletedStreamVersion = await activityPayloadTest.getLocationStreamVersion(
      client,
      database,
      productionRestoreGroupId,
    );

    await activityPayloadTest.changeActivitySourceRecord(
      client,
      database,
      productionRestoreMemberId,
      {
        isDeleted: false,
      },
    );
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["deduped_activities", "activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    expect(
      BigInt(
        await activityPayloadTest.getDedupedActivityVersion(
          client,
          database,
          productionRestoreGroupId,
        ),
      ),
    ).toBeGreaterThan(BigInt(deletedActivityVersion));
    expect(
      BigInt(
        await activityPayloadTest.getLocationStreamVersion(
          client,
          database,
          productionRestoreGroupId,
        ),
      ),
    ).toBeGreaterThan(BigInt(deletedStreamVersion));
    await activityPayloadTest.expectActiveLocationStream(
      client,
      database,
      productionRestoreGroupId,
      1,
    );

    const scopedActivityHistory = await activityPayloadTest.getDedupedActivityHistory(
      client,
      database,
      productionSliceGroupId,
    );
    const unrelatedRestoreVersion = await activityPayloadTest.getDedupedActivityVersion(
      client,
      database,
      productionRestoreGroupId,
    );
    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["deduped_activities"],
      "2026-09-07",
      "2026-09-08",
      [productionSliceMemberId],
    );
    expect(
      await activityPayloadTest.getDedupedActivityHistory(client, database, productionSliceGroupId),
    ).toEqual(scopedActivityHistory);
    expect(
      await activityPayloadTest.getDedupedActivityVersion(
        client,
        database,
        productionRestoreGroupId,
      ),
    ).toBe(unrelatedRestoreVersion);
  }, 240_000);
});
