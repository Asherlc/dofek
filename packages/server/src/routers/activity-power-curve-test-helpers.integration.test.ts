import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";
import { buildActivitySummaryRowsTableSql } from "../../../../src/db/clickhouse-activity-summary.ts";
import { rebuildTestActivityPowerCurve } from "./activity-power-curve-test-helpers.ts";
import { buildTestAnalyticsTableStatement } from "./clickhouse-integration-test-models.ts";

describe("canonical power-curve fixture rebuild", () => {
  const database = `curve_fixture_${randomUUID().replaceAll("-", "")}`;
  const userId = randomUUID();
  const activityId = randomUUID();
  let client: ClickHouseClient;
  let isolatedClient: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    isolatedClient = {
      command: (options) =>
        client.command({
          ...options,
          query: options.query.replaceAll("analytics.", `${database}.`),
        }),
      query: (options) =>
        client.query({ ...options, query: options.query.replaceAll("analytics.", `${database}.`) }),
    };
    await client.command({ query: `CREATE DATABASE ${database}` });
    await isolatedClient.command({ query: buildActivitySummaryRowsTableSql() });
    await isolatedClient.command({
      query: `CREATE TABLE analytics.activity_sensor_sample (
      activity_id UUID, user_id UUID, recorded_at DateTime64(6, 'UTC'),
      channel String, scalar Nullable(Float64), provider_id String, device_id Nullable(String),
      measurement_kind String, is_deleted UInt8, refresh_version UInt64
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id, recorded_at)`,
    });
    await isolatedClient.command({
      query: buildTestAnalyticsTableStatement("analytics.activity_power_curve"),
    });
    await isolatedClient.command({
      query: `INSERT INTO analytics.activity_summary_rows
        (activity_id, user_id, canonical_type, started_at, ended_at, power_sample_count, refresh_version, is_deleted, refreshed_at)
        VALUES ({activityId:UUID}, {userId:UUID}, 'cycling',
          '2026-10-01 12:00:00', '2026-10-01 12:01:00', 61, 1, 0, now64(9))`,
      query_params: { activityId, userId },
    });
    await isolatedClient.command({
      query: `INSERT INTO analytics.activity_sensor_sample
        SELECT {activityId:UUID}, {userId:UUID},
          toDateTime64('2026-10-01 12:00:00', 6, 'UTC') + toIntervalSecond(number),
          'power', 240, 'fixture', NULL, 'direct', 0, 1
        FROM numbers(61)`,
      query_params: { activityId, userId },
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
  });

  it("builds measured duration peaks from canonical summary and sensor rows on repeated rebuilds", async () => {
    for (let run = 0; run < 2; run++) {
      await rebuildTestActivityPowerCurve(isolatedClient);
      const result = await isolatedClient.query({
        query: `SELECT duration_seconds, best_power, coverage_pct, power_measurement_kind
          FROM analytics.activity_power_curve FINAL
          WHERE duration_seconds = 60 AND is_deleted = 0`,
        format: "JSONEachRow",
      });
      expect(
        z
          .array(
            z.object({
              duration_seconds: z.coerce.number(),
              best_power: z.coerce.number(),
              coverage_pct: z.coerce.number(),
              power_measurement_kind: z.string(),
            }),
          )
          .parse(await result.json()),
      ).toEqual([
        {
          duration_seconds: 60,
          best_power: 240,
          coverage_pct: 100,
          power_measurement_kind: "direct",
        },
      ]);
    }
  });
});
