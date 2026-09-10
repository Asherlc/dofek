import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, it } from "vitest";
import * as activityPayloadTest from "./activity-payload-dbt-microbatch-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

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
});
