import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  expectActiveLocationPointIds,
  insertLocationPoints,
  movedRouteGroupId,
  moveRouteMember,
  providerAPointIds,
  providerBPointIds,
  retainedRouteMemberId,
  routeGroupId,
  routeMemberId,
  runDbtBatch,
  seedLocationFixture,
  unrelatedPointId,
  unrelatedRouteGroupId,
  unrelatedRouteMemberId,
  userId,
} from "./activity-payload-dbt-microbatch-test-helpers.ts";
import { createActivitySourceRecordsSql } from "./activity-payload-dbt-source-test-helpers.ts";

const modelName = "activity_ghost_location_sample";

const ghostSampleSchema = z.object({
  sample_id: z.string(),
  provider_id: z.string(),
  member_id: z.string(),
  sample_time: z.string(),
});

type ClickHouseClient = ReturnType<typeof createClient>;

async function withGhostLocationDatabase(
  run: (client: ClickHouseClient, database: string, artifacts: string) => Promise<void>,
): Promise<void> {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) throw new Error("CLICKHOUSE_URL is required for Ghost Sessions location tests");
  const database = `activity_ghost_location_${randomBytes(6).toString("hex")}`;
  const artifacts = await mkdtemp(join(tmpdir(), "activity-ghost-location-dbt-"));
  const client = createClient({ url, request_timeout: 120_000 });
  try {
    await run(client, database, artifacts);
  } finally {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
    await rm(artifacts, { recursive: true, force: true });
  }
}

interface SourceMember {
  provider_id: string;
  canonical_type?: string;
  modality?: string;
  source_name?: string;
  raw?: string;
}

async function seedGhostLocationFixture(
  client: ClickHouseClient,
  database: string,
  routeMember: SourceMember = { provider_id: "strava" },
  retainedMember: SourceMember = { provider_id: "garmin" },
  unrelatedMember: SourceMember = { provider_id: "garmin" },
): Promise<void> {
  await seedLocationFixture(client, database);
  await client.command({
    query: `ALTER TABLE ${database}.deduped_activities
      ADD COLUMN canonical_type LowCardinality(String) DEFAULT 'running',
      ADD COLUMN modality Nullable(String) DEFAULT 'road'`,
  });
  await client.command({ query: createActivitySourceRecordsSql(database) });
  await client.insert({
    table: `${database}.activity_source_records`,
    format: "JSONEachRow",
    values: [
      { activity_id: routeMemberId, group_id: routeGroupId, ...routeMember },
      { activity_id: retainedRouteMemberId, group_id: routeGroupId, ...retainedMember },
      { activity_id: unrelatedRouteMemberId, group_id: unrelatedRouteGroupId, ...unrelatedMember },
    ].map((member) => ({
      user_id: userId,
      canonical_type: "running",
      modality: "road",
      source_synced_at: "2026-09-03 12:00:00",
      refresh_version: 1,
      refreshed_at: "2026-09-03 12:00:00",
      ...member,
    })),
  });
}

async function setGroupSport(
  client: ClickHouseClient,
  database: string,
  activityId: string,
  canonicalType: string,
  modality: string,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${database}.deduped_activities
      SELECT activity_id, user_id, started_at, ended_at, source_synced_at, member_activity_ids,
        refresh_version + 1, is_deleted, refreshed_at + INTERVAL 1 MICROSECOND, provider_type,
        {canonicalType:String}, {modality:String}
      FROM ${database}.deduped_activities FINAL
      WHERE activity_id = {activityId:UUID}`,
    query_params: { activityId, canonicalType, modality },
  });
}

async function expectGhostModelExists(client: ClickHouseClient, database: string): Promise<void> {
  const models = await client.query({
    query:
      "SELECT name FROM system.tables WHERE database = {database:String} AND name = {name:String}",
    query_params: { database, name: modelName },
    format: "JSONEachRow",
  });
  expect(await models.json()).toEqual([{ name: modelName }]);
}

async function queryActiveGhostSamples(
  client: ClickHouseClient,
  database: string,
  activityId: string,
) {
  const result = await client.query({
    query: `SELECT toString(source_metric_stream_id) AS sample_id, provider_id,
        toString(member_activity_id) AS member_id, formatDateTime(recorded_at, '%F %T', 'UTC') AS sample_time
      FROM ${database}.${modelName} FINAL
      WHERE user_id = {userId:UUID} AND activity_id = {activityId:UUID} AND is_deleted = 0
      ORDER BY recorded_at`,
    query_params: { userId, activityId },
    format: "JSONEachRow",
  });
  return z.array(ghostSampleSchema).parse(await result.json());
}

it("keeps the independent track when Strava wins the ordinary location ranking", async () => {
  await withGhostLocationDatabase(async (client, database, artifacts) => {
    await seedGhostLocationFixture(client, database);
    await insertLocationPoints(client, database, [
      [providerAPointIds[0], "strava", -122.3, 37.8, "2026-09-03 10:10:00", "2026-09-03 12:00:00"],
      [providerAPointIds[1], "strava", -122.29, 37.8, "2026-09-03 10:20:00", "2026-09-03 12:00:00"],
      [providerAPointIds[2], "strava", -122.28, 37.8, "2026-09-03 10:30:00", "2026-09-03 12:00:00"],
      [
        providerBPointIds[0],
        "garmin",
        -122.35,
        37.8,
        "2026-09-03 10:10:00",
        "2026-09-03 12:00:00",
        retainedRouteMemberId,
      ],
      [
        providerBPointIds[1],
        "garmin",
        -122.34,
        37.8,
        "2026-09-03 10:20:00",
        "2026-09-03 12:00:00",
        retainedRouteMemberId,
      ],
    ]);

    await runDbtBatch(
      database,
      artifacts,
      ["activity_location_sample", modelName],
      "2026-09-03",
      "2026-09-05",
    );
    await expectActiveLocationPointIds(client, database, routeGroupId, [...providerAPointIds]);
    await expectGhostModelExists(client, database);

    expect(await queryActiveGhostSamples(client, database, routeGroupId)).toEqual([
      {
        sample_id: providerBPointIds[0],
        provider_id: "garmin",
        member_id: retainedRouteMemberId,
        sample_time: "2026-09-03 10:10:00",
      },
      {
        sample_id: providerBPointIds[1],
        provider_id: "garmin",
        member_id: retainedRouteMemberId,
        sample_time: "2026-09-03 10:20:00",
      },
    ]);
  });
}, 240_000);

it("emits no ghost geometry for a Strava-only activity group", async () => {
  await withGhostLocationDatabase(async (client, database, artifacts) => {
    await seedGhostLocationFixture(
      client,
      database,
      { provider_id: "strava" },
      { provider_id: "strava" },
    );
    await insertLocationPoints(client, database, [
      [providerAPointIds[0], "strava", -122.3, 37.8, "2026-09-03 10:10:00", "2026-09-03 12:00:00"],
      [providerAPointIds[1], "strava", -122.29, 37.8, "2026-09-03 10:20:00", "2026-09-03 12:00:00"],
      [providerAPointIds[2], "strava", -122.28, 37.8, "2026-09-03 10:30:00", "2026-09-03 12:00:00"],
    ]);

    await runDbtBatch(
      database,
      artifacts,
      ["activity_location_sample", modelName],
      "2026-09-03",
      "2026-09-05",
    );
    await expectActiveLocationPointIds(client, database, routeGroupId, [...providerAPointIds]);
    await expectGhostModelExists(client, database);
    expect(await queryActiveGhostSamples(client, database, routeGroupId)).toEqual([]);
  });
}, 240_000);

it("tombstones ghost samples after the independent track is deleted", async () => {
  await withGhostLocationDatabase(async (client, database, artifacts) => {
    await seedGhostLocationFixture(client, database);
    await insertLocationPoints(client, database, [
      [providerAPointIds[0], "strava", -122.3, 37.8, "2026-09-03 10:10:00", "2026-09-03 12:00:00"],
      [providerAPointIds[1], "strava", -122.29, 37.8, "2026-09-03 10:20:00", "2026-09-03 12:00:00"],
      [
        providerBPointIds[0],
        "garmin",
        -122.35,
        37.8,
        "2026-09-03 10:10:00",
        "2026-09-03 12:00:00",
        retainedRouteMemberId,
      ],
      [
        providerBPointIds[1],
        "garmin",
        -122.34,
        37.8,
        "2026-09-03 10:20:00",
        "2026-09-03 12:00:00",
        retainedRouteMemberId,
      ],
    ]);

    await runDbtBatch(
      database,
      artifacts,
      ["activity_location_sample", modelName],
      "2026-09-03",
      "2026-09-05",
    );
    expect(await queryActiveGhostSamples(client, database, routeGroupId)).toHaveLength(2);

    await client.command({
      query: `INSERT INTO ${database}.metric_stream
        (id, activity_id, user_id, recorded_at, provider_id, channel, point,
         ingested_at, version, is_deleted) VALUES
        ('${providerBPointIds[0]}', '${retainedRouteMemberId}', '${userId}',
         toDateTime64('2026-09-03 10:10:00', 9, 'UTC'), 'garmin', 'location', NULL,
         toDateTime64('2026-09-03 13:00:00', 9, 'UTC'), 2, 1),
        ('${providerBPointIds[1]}', '${retainedRouteMemberId}', '${userId}',
         toDateTime64('2026-09-03 10:20:00', 9, 'UTC'), 'garmin', 'location', NULL,
         toDateTime64('2026-09-03 13:00:00', 9, 'UTC'), 2, 1)`,
    });

    await runDbtBatch(
      database,
      artifacts,
      ["activity_location_sample", modelName],
      "2026-09-03",
      "2026-09-05",
    );
    await expectActiveLocationPointIds(client, database, routeGroupId, [
      providerAPointIds[0],
      providerAPointIds[1],
    ]);
    expect(await queryActiveGhostSamples(client, database, routeGroupId)).toEqual([]);
  });
}, 240_000);

it("uses the direct member's sport and modality when the display classification differs", async () => {
  await withGhostLocationDatabase(async (client, database, artifacts) => {
    await seedGhostLocationFixture(
      client,
      database,
      { provider_id: "strava", canonical_type: "strength_training", modality: "indoor" },
      { provider_id: "garmin" },
      { provider_id: "garmin", canonical_type: "cycling", modality: "indoor" },
    );
    await setGroupSport(client, database, routeGroupId, "strength_training", "indoor");
    await setGroupSport(client, database, unrelatedRouteGroupId, "cycling", "road");
    await insertLocationPoints(client, database, [
      [
        providerBPointIds[0],
        "garmin",
        -122.35,
        37.8,
        "2026-09-03 10:10:00",
        "2026-09-03 12:00:00",
        retainedRouteMemberId,
      ],
      [
        providerBPointIds[1],
        "garmin",
        -122.34,
        37.8,
        "2026-09-03 10:20:00",
        "2026-09-03 12:00:00",
        retainedRouteMemberId,
      ],
      [
        unrelatedPointId,
        "garmin",
        -121.9,
        37.4,
        "2026-09-04 10:10:00",
        "2026-09-04 12:00:00",
        unrelatedRouteMemberId,
      ],
      [
        providerBPointIds[2],
        "garmin",
        -121.91,
        37.41,
        "2026-09-04 10:20:00",
        "2026-09-04 12:00:00",
        unrelatedRouteMemberId,
      ],
    ]);

    await runDbtBatch(
      database,
      artifacts,
      ["activity_location_sample", modelName],
      "2026-09-03",
      "2026-09-05",
    );
    await expectActiveLocationPointIds(client, database, routeGroupId, [
      providerBPointIds[0],
      providerBPointIds[1],
    ]);
    await expectActiveLocationPointIds(client, database, unrelatedRouteGroupId, [
      providerBPointIds[2],
      unrelatedPointId,
    ]);
    await expectGhostModelExists(client, database);

    expect(await queryActiveGhostSamples(client, database, routeGroupId)).toEqual([
      {
        sample_id: providerBPointIds[0],
        provider_id: "garmin",
        member_id: retainedRouteMemberId,
        sample_time: "2026-09-03 10:10:00",
      },
      {
        sample_id: providerBPointIds[1],
        provider_id: "garmin",
        member_id: retainedRouteMemberId,
        sample_time: "2026-09-03 10:20:00",
      },
    ]);
    expect(await queryActiveGhostSamples(client, database, unrelatedRouteGroupId)).toEqual([]);
  });
}, 240_000);

it.each([
  ["source bundle", { raw: '{"sourceBundle":"com.strava.strava"}' }],
  ["normalized source name", { source_name: "  StRaVa  " }],
] as const)(
  "excludes a denser Apple Health copy identified by %s",
  async (_evidence, copy) => {
    await withGhostLocationDatabase(async (client, database, artifacts) => {
      await seedGhostLocationFixture(client, database, { provider_id: "apple_health", ...copy });
      await insertLocationPoints(client, database, [
        [
          providerAPointIds[0],
          "apple_health",
          -122.3,
          37.8,
          "2026-09-03 10:10:00",
          "2026-09-03 12:00:00",
        ],
        [
          providerAPointIds[1],
          "apple_health",
          -122.29,
          37.8,
          "2026-09-03 10:20:00",
          "2026-09-03 12:00:00",
        ],
        [
          providerAPointIds[2],
          "apple_health",
          -122.28,
          37.8,
          "2026-09-03 10:30:00",
          "2026-09-03 12:00:00",
        ],
        [
          providerBPointIds[0],
          "garmin",
          -122.35,
          37.8,
          "2026-09-03 10:10:00",
          "2026-09-03 12:00:00",
          retainedRouteMemberId,
        ],
        [
          providerBPointIds[1],
          "garmin",
          -122.34,
          37.8,
          "2026-09-03 10:20:00",
          "2026-09-03 12:00:00",
          retainedRouteMemberId,
        ],
      ]);

      await runDbtBatch(
        database,
        artifacts,
        ["activity_location_sample", modelName],
        "2026-09-03",
        "2026-09-05",
      );
      await expectActiveLocationPointIds(client, database, routeGroupId, [...providerAPointIds]);
      expect(
        (await queryActiveGhostSamples(client, database, routeGroupId)).map((row) => row.sample_id),
      ).toEqual(providerBPointIds.slice(0, 2));
    });
  },
  240_000,
);

it("invalidates old ghost points when their raw member moves through a scoped refresh", async () => {
  await withGhostLocationDatabase(async (client, database, artifacts) => {
    await seedGhostLocationFixture(
      client,
      database,
      { provider_id: "garmin" },
      { provider_id: "strava" },
    );
    await insertLocationPoints(client, database, [
      [providerAPointIds[0], "garmin", -122.3, 37.8, "2026-09-03 10:10:00", "2026-09-03 12:00:00"],
      [providerAPointIds[1], "garmin", -122.29, 37.8, "2026-09-03 10:20:00", "2026-09-03 12:00:00"],
    ]);
    await runDbtBatch(
      database,
      artifacts,
      ["activity_location_sample", modelName],
      "2026-09-03",
      "2026-09-05",
    );
    expect(await queryActiveGhostSamples(client, database, routeGroupId)).toHaveLength(2);
    await moveRouteMember(client, database);

    const refreshMember = () =>
      runDbtBatch(database, artifacts, [modelName], "2026-09-03", "2026-09-05", [routeMemberId]);
    const ghostRows = async () => {
      const result = await client.query({
        query: `SELECT toString(activity_id) AS group_id, toString(source_metric_stream_id) AS sample_id,
            toString(refresh_version) AS version, is_deleted
          FROM ${database}.${modelName} FINAL
          WHERE user_id = {userId:UUID} AND member_activity_id = {memberId:UUID}
          ORDER BY activity_id, source_metric_stream_id`,
        query_params: { userId, memberId: routeMemberId },
        format: "JSONEachRow",
      });
      return result.json<{
        group_id: string;
        sample_id: string;
        version: string;
        is_deleted: number;
      }>();
    };

    await refreshMember();
    const movedRows = await ghostRows();
    expect(
      movedRows.map(({ group_id, sample_id, is_deleted }) => ({ group_id, sample_id, is_deleted })),
    ).toEqual([
      ...providerAPointIds
        .slice(0, 2)
        .map((sample_id) => ({ group_id: routeGroupId, sample_id, is_deleted: 1 })),
      ...providerAPointIds
        .slice(0, 2)
        .map((sample_id) => ({ group_id: movedRouteGroupId, sample_id, is_deleted: 0 })),
    ]);

    await refreshMember();
    expect(await ghostRows()).toEqual(movedRows);
  });
}, 240_000);
