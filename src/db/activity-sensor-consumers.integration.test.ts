import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAccountErasureFenceTableSql } from "../metric-stream/clickhouse-table.ts";
import { buildActivitySummaryRowsTableSql } from "./clickhouse-activity-summary.ts";
import { createMigration as createPolarizationMigration } from "./clickhouse-migrations/0116_cycling_polarization_elapsed_seconds.ts";
import { cyclingPowerSchemaStatements } from "./cycling-power-schema.ts";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

const userId = "00000000-0000-0000-0000-000000000001";
const cyclingId = "00000000-0000-0000-0000-000000000100";
const runningId = "00000000-0000-0000-0000-000000000200";

describe("activity sensor consumers before background merges", () => {
  const database = `activity_sensor_consumers_${randomBytes(6).toString("hex")}`;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url) throw new Error("CLICKHOUSE_URL is required for sensor consumer tests");
    client = createClient({ url });
    const statements = [
      `CREATE DATABASE ${database}`,
      buildAccountErasureFenceTableSql().replaceAll("ingest.", `${database}.`),
      buildActivitySummaryRowsTableSql().replaceAll("analytics.", `${database}.`),
      ...cyclingPowerSchemaStatements().map((query) =>
        query.replaceAll("analytics.", `${database}.`).replaceAll("ingest.", `${database}.`),
      ),
      `INSERT INTO ${database}.activity_summary_rows
        (activity_id,user_id,canonical_type,name,started_at,ended_at,power_sample_count,refresh_version,is_deleted,refreshed_at)
        SELECT toUUID(tupleElement(activity, 1)), toUUID('${userId}'),
          tupleElement(activity, 2), tupleElement(activity, 2),
          toDateTime64(today() - INTERVAL 1 DAY, 6, 'UTC') + INTERVAL 14 HOUR,
          toDateTime64(today() - INTERVAL 1 DAY, 6, 'UTC') + INTERVAL 14 HOUR + INTERVAL 10 MINUTE,
          if(tupleElement(activity, 2) = 'cycling', 600, 0), 1, 0, now64(9)
        FROM (SELECT arrayJoin([('${cyclingId}', 'cycling'), ('${runningId}', 'running')]) AS activity)`,
      `CREATE TABLE ${database}.deduped_activities
        ENGINE = ReplacingMergeTree ORDER BY (user_id, activity_id) AS
        SELECT activity_id, user_id, canonical_type, started_at, ended_at,
          [activity_id] AS member_activity_ids, is_deleted, now64(9) AS refreshed_at
        FROM ${database}.activity_summary_rows`,
      `CREATE TABLE ${database}.user_profile_current (
        id UUID, max_hr Int32, resting_hr Int32, updated_at DateTime64(9, 'UTC')
      ) ENGINE = MergeTree ORDER BY id`,
      `INSERT INTO ${database}.user_profile_current VALUES ('${userId}', 200, 60, now64(9))`,
      `CREATE TABLE ${database}.resting_heart_rate_sleep_window (
        user_id UUID, ended_at DateTime64(6, 'UTC'), resting_hr Int32,
        is_deleted UInt8, refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree ORDER BY (user_id, ended_at)`,
      `INSERT INTO ${database}.resting_heart_rate_sleep_window
        SELECT toUUID('${userId}'),
          toDateTime64(today() - INTERVAL 1 DAY, 6, 'UTC') + INTERVAL 8 HOUR,
          60, 0, now64(9)`,
      `CREATE TABLE ${database}.body_measurement (
        user_id UUID, recorded_at DateTime64(6, 'UTC'), weight_kg Float64, is_deleted UInt8
      ) ENGINE = ReplacingMergeTree ORDER BY (user_id, recorded_at)`,
      `INSERT INTO ${database}.body_measurement SELECT toUUID('${userId}'), now64(6), 75, 0`,
      `CREATE TABLE ${database}.activity (
        group_id UUID, _peerdb_synced_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree ORDER BY group_id`,
      `CREATE TABLE ${database}.body_measurement_sample (
        user_id UUID, channel String, _peerdb_synced_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree ORDER BY (user_id, channel)`,
      `CREATE TABLE ${database}.user_profile (
        id UUID, _peerdb_synced_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree ORDER BY id`,
      `CREATE TABLE ${database}.activity_sensor_sample (
        activity_id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'),
        recorded_date Date, channel String, scalar Nullable(Float64),
        refresh_version UInt64, is_deleted UInt8, refreshed_at DateTime64(9, 'UTC'),
        measurement_kind String DEFAULT 'unknown'
      ) ENGINE = ReplacingMergeTree(refresh_version)
        ORDER BY (user_id, activity_id, recorded_date, channel, recorded_at)`,
      `SYSTEM STOP MERGES ${database}.activity_sensor_sample`,
    ];
    for (const statement of statements) await client.command({ query: statement });

    // Keep repeated versions, corrected values, and retracted samples in separate
    // unmerged parts. The last 60 samples and one interior power sample are
    // retracted, so ASOF joins must skip the deleted point's original live value.
    for (const version of [1, 2, 3]) {
      await client.command({
        query: `INSERT INTO ${database}.activity_sensor_sample
          (activity_id, user_id, recorded_at, recorded_date, channel, scalar,
            refresh_version, is_deleted, refreshed_at)
          SELECT activity_id, user_id, addSeconds(started_at, toInt64(number)),
            toDate(started_at), channel,
            multiIf(channel = 'heart_rate', ${version === 1 ? 190 : 150},
              channel = 'power', ${version === 1 ? 400 : 200},
              channel = 'speed', ${version === 1 ? 4 : 3}, 100),
            ${version}, toUInt8(${version} > 1 AND (
              number >= 301 OR (channel = 'power' AND number = 150))), now64(9)
          FROM ${database}.activity_summary_rows
          CROSS JOIN numbers(361) AS sample_numbers
          ARRAY JOIN if(canonical_type = 'cycling', ['heart_rate', 'power'],
            ['heart_rate', 'speed', 'altitude']) AS channel`,
      });
    }
    const physical = await client.query({
      query: `SELECT toUInt32(count()) AS rows FROM ${database}.activity_sensor_sample`,
      format: "JSONEachRow",
    });
    expect(await physical.json()).toEqual([{ rows: 5415 }]);
  }, 120_000);

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it.each([
    {
      model: "activity_polarization_zones",
      columns:
        "z1_microseconds / 1000000.0 AS z1_seconds, z2_microseconds / 1000000.0 AS z2_seconds, z3_microseconds / 1000000.0 AS z3_seconds, is_deleted",
      expected: [
        { activity_id: cyclingId, z1_seconds: 310, z2_seconds: 0, z3_seconds: 0, is_deleted: 0 },
      ],
    },
    {
      model: "activity_aerobic_efficiency",
      columns: "avg_power_z2, avg_hr_z2, efficiency_factor, z2_samples, is_deleted",
      expected: [
        {
          activity_id: cyclingId,
          avg_power_z2: 200,
          avg_hr_z2: 150,
          efficiency_factor: 1.333,
          // Readings at seconds 0–300 bound 300 contributing intervals;
          // the endpoint reading has no elapsed duration to contribute.
          z2_samples: 300,
          is_deleted: 0,
        },
        {
          activity_id: runningId,
          avg_power_z2: 0,
          avg_hr_z2: 0,
          efficiency_factor: 0,
          z2_samples: 0,
          is_deleted: 1,
        },
      ],
    },
    {
      model: "activity_vo2max_estimate",
      columns: "method, round(vo2max, 1) AS vo2max, is_deleted",
      expected: [
        { activity_id: cyclingId, method: "cycling_power", vo2max: 35.8, is_deleted: 0 },
        { activity_id: runningId, method: "submaximal_acsm", vo2max: 61.4, is_deleted: 0 },
      ],
    },
  ])(
    "$model resolves corrections and tombstones before aggregation",
    async ({ model, columns, expected }) => {
      const sql = renderDbtModelSql(readModelSql(`${model}.sql`), {
        isIncremental: false,
        activityRefreshScoped: false,
      })
        .replaceAll("{{ initial_lookback_days }}", "365")
        .replace(/\{\{ ref\('([^']+)'\) \}\}/g, `${database}.$1`)
        .replace(/\{\{ source\('[^']+', '([^']+)'\) \}\}/g, `${database}.$1`);
      const result = await client.query({
        query: `SELECT toString(activity_id) AS activity_id, ${columns}
        FROM (${sql}) ORDER BY activity_id
        SETTINGS join_use_nulls = 1, max_threads = 1`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual(expected);
    },
    120_000,
  );

  it("stores elapsed cycling zone coverage with exact HR boundaries and bounded gaps", async () => {
    // The test retracts its own readings. Isolate each attempt from any
    // higher-version rows that a previous attempt may have written.
    const rideId = randomUUID();
    const riderId = randomUUID();
    await client.command({
      query: `INSERT INTO ${database}.user_profile_current VALUES ('${riderId}', 189, 60, now64(9))`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_summary_rows
        (activity_id,user_id,canonical_type,name,started_at,ended_at,refresh_version,is_deleted,refreshed_at)
        SELECT toUUID('${rideId}'),toUUID('${riderId}'),canonical_type,name,started_at,ended_at,1,0,now64(9)
        FROM ${database}.activity_summary_rows FINAL WHERE activity_id = toUUID('${cyclingId}')`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample
        SELECT activity_id, user_id, addMicroseconds(started_at, reading.1),
          toDate(started_at), 'heart_rate', reading.2, 4, 0, now64(9), reading.3
        FROM ${database}.activity_summary_rows
        ARRAY JOIN [(400000000, 149.0, 'direct'), (402500000, 151.2, 'direct'),
          (407000000, 170.1, 'direct'), (410000000, 150.0, 'estimated'),
          (439000000, 185.0, 'unknown'), (599000000, 160.0, 'direct'),
          (600000000, 190, 'direct')] AS reading
        WHERE activity_id = toUUID('${rideId}')`,
    });
    const modelSql = (isIncremental: boolean) =>
      renderDbtModelSql(readModelSql("activity_polarization_zones.sql"), {
        isIncremental,
        activityRefreshScoped: false,
      })
        .replace(/\{\{ ref\('([^']+)'\) \}\}/g, `${database}.$1`)
        .replace(/\{\{ source\('[^']+', '([^']+)'\) \}\}/g, `${database}.$1`)
        .replaceAll("{{ this }}", `${database}.activity_cycling_polarization`);
    for (const statement of createPolarizationMigration().statements) {
      await client.command({ query: statement.replaceAll("analytics.", `${database}.`) });
    }
    await client.command({
      query: `INSERT INTO ${database}.activity_cycling_polarization
        SELECT * FROM (${modelSql(false)})
        WHERE activity_id = toUUID('${rideId}')
        SETTINGS join_use_nulls = 1, max_threads = 1`,
    });
    const result = await client.query({
      query: `SELECT
        z1_microseconds / 1000000.0 AS z1_seconds,
        z2_microseconds / 1000000.0 AS z2_seconds,
        z3_microseconds / 1000000.0 AS z3_seconds
        FROM ${database}.activity_cycling_polarization FINAL
        WHERE activity_id = toUUID('${rideId}')`,
      format: "JSONEachRow",
    });
    expect(await result.json()).toEqual([{ z1_seconds: 2.5, z2_seconds: 5.5, z3_seconds: 13 }]);

    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample
        SELECT activity_id, user_id, recorded_at, recorded_date, channel, scalar,
          5, 1, now64(9), measurement_kind
        FROM ${database}.activity_sensor_sample FINAL
        WHERE activity_id = toUUID('${rideId}') AND channel = 'heart_rate' AND is_deleted = 0`,
    });
    const refresh = () =>
      client.command({
        query: `INSERT INTO ${database}.activity_cycling_polarization
        ${modelSql(true)} SETTINGS join_use_nulls = 1, max_threads = 1`,
      });
    const storedCoverage = async () => {
      const result = await client.query({
        query: `SELECT is_deleted,
          (z1_microseconds + z2_microseconds + z3_microseconds) / 1000000.0 AS total_seconds
          FROM ${database}.activity_cycling_polarization FINAL
          WHERE activity_id = toUUID('${rideId}')`,
        format: "JSONEachRow",
      });
      return result.json();
    };
    await refresh();
    expect(await storedCoverage()).toEqual([{ is_deleted: 0, total_seconds: 0 }]);
    await client.command({
      query: `INSERT INTO ${database}.activity_summary_rows
        (activity_id,user_id,canonical_type,name,started_at,ended_at,refresh_version,is_deleted,refreshed_at)
        SELECT activity_id,user_id,'running',name,started_at,ended_at,refresh_version + 1,0,now64(9)
        FROM ${database}.activity_summary_rows FINAL WHERE activity_id = toUUID('${rideId}')`,
    });
    await refresh();
    expect(await storedCoverage()).toEqual([{ is_deleted: 1, total_seconds: 0 }]);
  }, 120_000);
});
