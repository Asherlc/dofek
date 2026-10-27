import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import * as activityPayloadTest from "./activity-payload-dbt-microbatch-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const queryMemorySchema = z.array(
  z.object({
    memory_usage: z.coerce.number(),
    read_rows: z.coerce.number(),
  }),
);

const clickHouseTimestampSchema = z.tuple([
  z.object({
    started_at: z.string(),
  }),
]);

describe("bounded activity location dbt reconciliation", () => {
  let client: ClickHouseClient;
  let artifactDirectory: string;
  const database = `bounded_activity_location_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    const clickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
    if (!clickHouseUrl) {
      throw new Error("CLICKHOUSE_URL is required for activity payload integration tests");
    }
    client = createClient({ url: clickHouseUrl, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    artifactDirectory = await mkdtemp(join(tmpdir(), "bounded-activity-location-dbt-"));
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

  it("drains a location backlog across bounded runs without skipping groups", async () => {
    await activityPayloadTest.seedLocationFixture(client, database);
    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        activityPayloadTest.providerAPointIds[0],
        "provider-a",
        -122.3,
        37.8,
        "2026-09-03 10:10:00",
        "2026-09-03 12:00:00",
      ],
      [
        activityPayloadTest.unrelatedPointId,
        "provider-z",
        -121.9,
        37.4,
        "2026-09-04 10:10:00",
        "2026-09-04 12:00:00",
        activityPayloadTest.unrelatedRouteMemberId,
      ],
    ]);

    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample"],
      "2026-09-03",
      "2026-09-05",
      undefined,
      1,
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.routeGroupId,
      [activityPayloadTest.providerAPointIds[0]],
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.unrelatedRouteGroupId,
      [],
    );

    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample"],
      "2026-09-03",
      "2026-09-05",
      undefined,
      1,
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.routeGroupId,
      [activityPayloadTest.providerAPointIds[0]],
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.unrelatedRouteGroupId,
      [activityPayloadTest.unrelatedPointId],
    );
  }, 240_000);

  it("does not let a new deleted-only location group consume a bounded batch slot", async () => {
    await activityPayloadTest.seedLocationFixture(client, database);
    await client.command({
      query: `INSERT INTO ${database}.metric_stream
        (id, activity_id, user_id, recorded_at, provider_id, channel, point,
         ingested_at, version, is_deleted) VALUES
        ('${activityPayloadTest.providerAPointIds[0]}', '${activityPayloadTest.routeMemberId}', '${activityPayloadTest.userId}',
         toDateTime64('2026-09-03 10:10:00', 9, 'UTC'), 'provider-a', 'location', NULL,
         toDateTime64('2026-09-03 11:00:00', 9, 'UTC'), 1, 1)`,
    });
    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        activityPayloadTest.unrelatedPointId,
        "provider-z",
        -121.9,
        37.4,
        "2026-09-04 10:10:00",
        "2026-09-04 12:00:00",
        activityPayloadTest.unrelatedRouteMemberId,
      ],
    ]);

    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample"],
      "2026-09-03",
      "2026-09-05",
      undefined,
      1,
    );

    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.routeGroupId,
      [],
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.unrelatedRouteGroupId,
      [activityPayloadTest.unrelatedPointId],
    );
  }, 240_000);

  it("builds point state only for groups inside the bounded batch", async () => {
    await activityPayloadTest.seedLocationFixture(client, database);
    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        activityPayloadTest.providerAPointIds[0],
        "provider-a",
        -122.3,
        37.8,
        "2026-09-03 10:10:00",
        "2026-09-03 12:00:00",
      ],
    ]);
    await client.command({
      query: `INSERT INTO ${database}.metric_stream
        (id, activity_id, user_id, recorded_at, provider_id, channel, point,
         ingested_at, version, is_deleted)
        SELECT generateUUIDv4(), toUUID('${activityPayloadTest.unrelatedRouteMemberId}'),
          toUUID('${activityPayloadTest.userId}'),
          addMilliseconds(toDateTime64('2026-09-04 10:00:00', 9, 'UTC'), number),
          'provider-z', 'location', tuple(-121.9, 37.4),
          toDateTime64('2026-09-04 12:00:00', 9, 'UTC'), 1, 0
        FROM numbers(100000)`,
    });
    const timestampResult = await client.query({
      query: "SELECT toString(now64(6)) AS started_at",
      format: "JSONEachRow",
    });
    const [{ started_at: startedAt }] = clickHouseTimestampSchema.parse(
      await timestampResult.json(),
    );

    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample"],
      "2026-09-03",
      "2026-09-05",
      undefined,
      1,
    );
    await client.command({ query: "SYSTEM FLUSH LOGS" });

    const result = await client.query({
      query: `SELECT memory_usage, read_rows
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
    const [queryMemory] = queryMemorySchema.parse(await result.json());

    expect(queryMemory).toBeDefined();
    expect(queryMemory?.memory_usage).toBeLessThan(50 * 1024 * 1024);
    expect(queryMemory?.read_rows).toBeLessThan(50_000);
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.routeGroupId,
      [activityPayloadTest.providerAPointIds[0]],
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.unrelatedRouteGroupId,
      [],
    );
  }, 240_000);

  it("checkpoints a selected group whose location history resolves to no live points", async () => {
    await activityPayloadTest.seedLocationFixture(client, database);
    await activityPayloadTest.insertLocationPoints(client, database, [
      [
        activityPayloadTest.providerAPointIds[0],
        "provider-a",
        -122.3,
        37.8,
        "2026-09-03 10:10:00",
        "2026-09-03 11:00:00",
      ],
      [
        activityPayloadTest.unrelatedPointId,
        "provider-z",
        -121.9,
        37.4,
        "2026-09-04 10:10:00",
        "2026-09-04 13:00:00",
        activityPayloadTest.unrelatedRouteMemberId,
      ],
    ]);
    await client.command({
      query: `INSERT INTO ${database}.metric_stream
        (id, activity_id, user_id, recorded_at, provider_id, channel, point,
         ingested_at, version, is_deleted) VALUES
        ('${activityPayloadTest.providerAPointIds[0]}', '${activityPayloadTest.routeMemberId}',
         '${activityPayloadTest.userId}', toDateTime64('2026-09-03 10:10:00', 9, 'UTC'),
         'provider-a', 'location', NULL,
         toDateTime64('2026-09-03 12:00:00', 9, 'UTC'), 2, 1)`,
    });

    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample"],
      "2026-09-03",
      "2026-09-05",
      undefined,
      1,
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.routeGroupId,
      [],
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.unrelatedRouteGroupId,
      [],
    );

    await activityPayloadTest.runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample"],
      "2026-09-03",
      "2026-09-05",
      undefined,
      1,
    );
    await activityPayloadTest.expectActiveLocationPointIds(
      client,
      database,
      activityPayloadTest.unrelatedRouteGroupId,
      [activityPayloadTest.unrelatedPointId],
    );
  }, 240_000);
});
