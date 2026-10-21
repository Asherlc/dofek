import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  movedMemberId,
  oldGroupId,
  runDbtBatch,
  seedSensorFixture,
  unrelatedGroupId,
  userId,
} from "./activity-payload-dbt-microbatch-test-helpers.ts";

describe("activity sensor sample append reconciliation", () => {
  const database = `activity_sensor_append_${randomBytes(6).toString("hex")}`;
  let client: ReturnType<typeof createClient>;
  let artifactDirectory: string;

  beforeAll(async () => {
    const clickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
    if (!clickHouseUrl) throw new Error("CLICKHOUSE_URL is required for sensor append tests");
    client = createClient({ url: clickHouseUrl });
    artifactDirectory = await mkdtemp(join(tmpdir(), "activity-sensor-append-"));
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
    await rm(artifactDirectory, { recursive: true, force: true });
  });

  it("retains mergeable projected versions when a bounded sensor batch is replayed", async () => {
    await seedSensorFixture(client, database);
    const build = () =>
      runDbtBatch(
        database,
        artifactDirectory,
        ["activity_sensor_sample"],
        "2026-09-04",
        "2026-09-05",
      );
    await build();
    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor
          (user_id, recorded_at, recorded_date, channel, scalar, source_activity_id,
           refresh_version, is_deleted, refreshed_at) VALUES
          ('${userId}', toDateTime64('2026-09-04 10:30:00', 9, 'UTC'),
           toDate('2026-09-04'), 'heart_rate', 150, '${movedMemberId}', 2, 0,
           toDateTime64('2026-09-04 13:00:00', 9, 'UTC'))`,
    });
    await build();

    const parts = await client.query({
      query: `SELECT projections FROM system.parts
          WHERE database = '${database}' AND table = 'activity_sensor_sample' AND active`,
      format: "JSONEachRow",
    });
    const partRows = z
      .array(z.object({ projections: z.array(z.string()) }))
      .parse(await parts.json());
    expect(partRows.length).toBeGreaterThan(0);
    for (const part of partRows) {
      expect(part.projections).toContain("by_activity_source_refresh_version");
    }

    const current = await client.query({
      query: `SELECT toString(activity_id) AS activity_id, scalar, is_deleted
        FROM ${database}.activity_sensor_sample FINAL ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    expect(await current.json()).toEqual([{ activity_id: oldGroupId, scalar: 150, is_deleted: 0 }]);

    await client.command({
      query: `OPTIMIZE TABLE ${database}.activity_sensor_sample FINAL`,
    });
    const merged = await client.query({
      query: `SELECT toUInt32(count()) AS parts FROM system.parts
        WHERE database = '${database}' AND table = 'activity_sensor_sample' AND active`,
      format: "JSONEachRow",
    });
    expect(await merged.json()).toEqual([{ parts: 1 }]);
  }, 120_000);

  it("builds multiple historical daily batches and retracts a later deleted sample", async () => {
    await seedSensorFixture(client, database);
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_sensor_sample"],
      "2026-09-04",
      "2026-09-06",
    );
    const historical = await client.query({
      query: `SELECT toString(activity_id) AS activity_id, scalar, is_deleted
        FROM ${database}.activity_sensor_sample FINAL ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    expect(await historical.json()).toEqual([
      { activity_id: oldGroupId, scalar: 100, is_deleted: 0 },
      { activity_id: unrelatedGroupId, scalar: 120, is_deleted: 0 },
    ]);

    await client.command({
      query: `INSERT INTO ${database}.deduped_sensor
        (user_id, recorded_at, recorded_date, channel, scalar, source_activity_id,
         refresh_version, is_deleted, refreshed_at) VALUES
        ('${userId}', toDateTime64('2026-09-04 10:30:00', 9, 'UTC'), toDate('2026-09-04'),
         'heart_rate', 100, '${movedMemberId}', 2, 1,
         toDateTime64('2026-09-07 12:00:00', 9, 'UTC'))`,
    });
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_sensor_sample"],
      "2026-09-07",
      "2026-09-08",
    );
    const retracted = await client.query({
      query: `SELECT toString(activity_id) AS activity_id, scalar, is_deleted
        FROM ${database}.activity_sensor_sample FINAL ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    expect(await retracted.json()).toEqual([
      { activity_id: oldGroupId, scalar: 100, is_deleted: 1 },
      { activity_id: unrelatedGroupId, scalar: 120, is_deleted: 0 },
    ]);
  }, 120_000);
});
