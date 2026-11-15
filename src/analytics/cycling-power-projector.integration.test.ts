import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { cyclingPowerSchemaStatements } from "../db/cycling-power-schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { buildAccountErasureFenceTableSql } from "../metric-stream/clickhouse-table.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "./analytics-query-owner.ts";
import { projectCyclingPower as projectOwnedCyclingPower } from "./cycling-power-projector.ts";

const policy = {
  coveragePolicy: {
    maximumHoldSeconds: 10,
    minimumGapSeconds: 5,
    gapIntervalMultiplier: 2,
    maximumGapSeconds: 10,
  },
};

describe("cycling power projector", () => {
  let context: TestContext;
  const real = createClickHouseClientFromEnv();
  const database = `cycling_projector_${randomUUID().replaceAll("-", "")}`;
  const rewrite = (query: string) =>
    query
      .replaceAll("analytics.", `${database}.`)
      .replaceAll("ingest.account_erasure_fence", `${database}.account_erasure_fence`);
  const insert = real.insert;
  if (!insert) throw new Error("Test client requires insert support");
  const client = {
    exec: (options) => real.exec({ ...options, query: rewrite(options.query) }),
    command: (options) => real.command({ ...options, query: rewrite(options.query) }),
    query: (options) => real.query({ ...options, query: rewrite(options.query) }),
    insert: (options) => insert.call(real, { ...options, table: rewrite(options.table) }),
  } satisfies ClickHouseClient;
  const asOf = new Date("2026-11-01T12:00:00Z");

  function projectCyclingPower(
    target: ClickHouseClient,
    projectionPolicy: Parameters<typeof projectOwnedCyclingPower>[1],
    at: Date,
  ) {
    return withAnalyticsQueryOwner(
      context.db,
      target,
      { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId: `cycling-fixture:${database}` },
      (owner) => projectOwnedCyclingPower(owner, projectionPolicy, at),
    );
  }

  beforeAll(async () => {
    context = await setupTestDatabase();
    await real.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: buildAccountErasureFenceTableSql() });
    await client.command({
      query: `CREATE TABLE analytics.activity_summary_rows
      (user_id UUID,activity_id UUID,started_at DateTime64(6,'UTC'),ended_at Nullable(DateTime64(6,'UTC')),
       canonical_type Nullable(String),power_sample_count Nullable(UInt64),refresh_version UInt64,is_deleted UInt8)
      ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE analytics.activity_sensor_sample
      (user_id UUID,activity_id UUID,recorded_at DateTime64(6,'UTC'),channel String,scalar Nullable(Float64),
       refresh_version UInt64,is_deleted UInt8)
      ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id,channel,recorded_at)`,
    });
    await client.command({
      query: `CREATE TABLE analytics.activity_power_curve
      (user_id UUID,activity_id UUID,duration_seconds UInt32,best_power Float64,refresh_version UInt64,is_deleted UInt8)
      ENGINE=ReplacingMergeTree(refresh_version) ORDER BY (user_id,activity_id,duration_seconds)`,
    });
    for (const statement of cyclingPowerSchemaStatements())
      await client.command({ query: statement });
  });

  beforeEach(async () => {
    for (const table of [
      "account_erasure_fence",
      "activity_summary_rows",
      "activity_sensor_sample",
      "activity_power_curve",
      "cycling_power_observation_rows",
    ]) {
      await client.command({ query: `TRUNCATE TABLE analytics.${table}` });
    }
  });

  afterAll(async () => {
    await real.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await real.close?.();
    await context?.cleanup();
  });

  async function seed(
    userId: string,
    ids: string[],
    version = 100,
    watts = 250,
    canonicalType = "cycling",
    activityDate = "2026-10-31",
  ) {
    await client.insert({
      table: "analytics.activity_summary_rows",
      format: "JSONEachRow",
      values: ids.map((id) => ({
        user_id: userId,
        activity_id: id,
        started_at: `${activityDate} 10:00:00`,
        ended_at: `${activityDate} 10:01:00`,
        canonical_type: canonicalType,
        power_sample_count: 60,
        refresh_version: version,
        is_deleted: 0,
      })),
    });
    await client.insert({
      table: "analytics.activity_sensor_sample",
      format: "JSONEachRow",
      values: ids.flatMap((id) =>
        Array.from({ length: 60 }, (_, second) => ({
          user_id: userId,
          activity_id: id,
          recorded_at: `${activityDate} 10:00:${String(second).padStart(2, "0")}`,
          channel: "power",
          scalar: watts,
          refresh_version: version,
          is_deleted: 0,
        })),
      ),
    });
    await client.insert({
      table: "analytics.activity_power_curve",
      format: "JSONEachRow",
      values: ids.map((id) => ({
        user_id: userId,
        activity_id: id,
        duration_seconds: 60,
        best_power: watts,
        refresh_version: version,
        is_deleted: 0,
      })),
    });
  }

  it("projects changed activities in bounded batches", async () => {
    const userId = randomUUID();
    await seed(
      userId,
      Array.from({ length: 101 }, () => randomUUID()),
    );
    let nativeReads = 0;
    let observationWrites = 0;
    const measuredClient: typeof client = {
      ...client,
      query: (options) => {
        if (options.query.startsWith("SELECT toFloat64(toUnixTimestamp64Milli(recorded_at))"))
          nativeReads += 1;
        return client.query(options);
      },
      exec: (options) => {
        if (options.query.startsWith("INSERT INTO analytics.cycling_power_observation_rows"))
          observationWrites += 1;
        return client.exec(options);
      },
    };
    expect(await projectCyclingPower(measuredClient, policy, asOf)).toEqual({
      pendingActivities: 1,
    });
    expect(nativeReads).toBe(100);
    expect(observationWrites).toBe(1);
    expect(await projectCyclingPower(client, policy, asOf)).toEqual({ pendingActivities: 0 });
  });

  it("serves normalized power and activity metadata without threshold history", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    await seed(userId, [activityId]);
    await expect(projectCyclingPower(client, policy, asOf)).resolves.toEqual({
      pendingActivities: 0,
    });
    const servingRows = await client
      .query<{
        normalized_power: number | null;
        activity_id: string;
        canonical_type: string;
        ended_at: string;
      }>({
        query: `SELECT normalized_power,activity_id,canonical_type,toString(ended_at) AS ended_at
          FROM analytics.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId },
      })
      .then((result) => result.json());
    expect(servingRows).toHaveLength(1);
    expect(servingRows[0]).toMatchObject({
      normalized_power: 250,
      activity_id: activityId,
      canonical_type: "cycling",
    });
  });

  it("hides a published observation immediately after account erasure is fenced", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    await seed(userId, [activityId]);
    await projectCyclingPower(client, policy, asOf);

    const readServingRows = () =>
      client
        .query<{ normalized_power: number | null; activity_id: string }>({
          query: `SELECT normalized_power,activity_id
            FROM analytics.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
          format: "JSONEachRow",
          query_params: { userId },
        })
        .then((result) => result.json());

    expect(await readServingRows()).toEqual([{ normalized_power: 250, activity_id: activityId }]);
    await client.command({
      query: `INSERT INTO ingest.account_erasure_fence (user_hash)
        SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
      query_params: { userId },
    });
    expect(await readServingRows()).toEqual([]);
  });

  it("refreshes normalized power for changed sources and hides deleted activities", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    await seed(userId, [activityId]);
    await projectCyclingPower(client, policy, asOf);
    const read = () =>
      client
        .query<{ normalized_power: number | null }>({
          query: `SELECT normalized_power FROM analytics.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
          format: "JSONEachRow",
          query_params: { userId },
        })
        .then((result) => result.json());
    expect((await read())[0]?.normalized_power).toBe(250);

    await seed(userId, [activityId], 200, 300);
    await projectCyclingPower(client, policy, asOf);
    expect((await read())[0]?.normalized_power).toBe(300);

    await client.insert({
      table: "analytics.activity_summary_rows",
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: activityId,
          started_at: "2026-10-31 10:00:00",
          ended_at: "2026-10-31 10:01:00",
          canonical_type: "cycling",
          power_sample_count: 60,
          refresh_version: 300,
          is_deleted: 1,
        },
      ],
    });
    await projectCyclingPower(client, policy, asOf);
    expect(await read()).toEqual([]);
  });

  it("withholds stale normalized power after activity metadata changes until refresh", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    await seed(userId, [activityId]);
    await projectCyclingPower(client, policy, asOf);
    await client.insert({
      table: "analytics.activity_summary_rows",
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: activityId,
          started_at: "2026-10-31 10:00:00",
          ended_at: "2026-10-31 10:01:00",
          canonical_type: "cycling",
          power_sample_count: 60,
          refresh_version: 200,
          is_deleted: 0,
        },
      ],
    });
    const read = () =>
      client
        .query<{ normalized_power: number | null }>({
          query: `SELECT normalized_power FROM analytics.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
          format: "JSONEachRow",
          query_params: { userId },
        })
        .then((result) => result.json());
    expect(await read()).toEqual([]);
    await projectCyclingPower(client, policy, asOf);
    expect((await read())[0]?.normalized_power).toBe(250);
  });

  it("retains invalid-watt barriers and projects power for non-cycling activities", async () => {
    const userId = randomUUID();
    const cyclingId = randomUUID();
    const runningId = randomUUID();
    await seed(userId, [cyclingId], 100, 250);
    await seed(userId, [runningId], 100, 300, "running");
    await client.insert({
      table: "analytics.activity_sensor_sample",
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: cyclingId,
          recorded_at: "2026-10-31 10:00:30",
          channel: "power",
          scalar: -1,
          refresh_version: 200,
          is_deleted: 0,
        },
      ],
    });
    expect(await projectCyclingPower(client, policy, asOf)).toEqual({ pendingActivities: 0 });
    const observations = await client
      .query<{ activity_id: string; normalized_power: number | null }>({
        query: `SELECT activity_id,normalized_power FROM analytics.cycling_power_observation_rows FINAL WHERE user_id={userId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId },
      })
      .then((result) => result.json());
    expect(observations.find((row) => row.activity_id === cyclingId)?.normalized_power).toBeNull();
    expect(observations.find((row) => row.activity_id === runningId)?.normalized_power).toBe(300);
  });

  it.each(["11:00:00", "15:00:00"])(
    "projects a ride only when completed and removes it after a clock rewind (%s)",
    async (startTime) => {
      const userId = randomUUID();
      const activityId = randomUUID();
      await seed(userId, [activityId]);
      await client.insert({
        table: "analytics.activity_summary_rows",
        format: "JSONEachRow",
        values: [
          {
            user_id: userId,
            activity_id: activityId,
            started_at: `2026-11-01 ${startTime}`,
            ended_at: "2026-11-01 15:45:00",
            canonical_type: "cycling",
            power_sample_count: 60,
            refresh_version: 200,
            is_deleted: 0,
          },
        ],
      });
      const countObservations = () =>
        client
          .query<{ count: number }>({
            query: `SELECT countIf(is_deleted=0) AS count FROM analytics.cycling_power_observation_rows FINAL WHERE user_id={userId:UUID}`,
            format: "JSONEachRow",
            query_params: { userId },
          })
          .then((result) => result.json());
      const countMetrics = () =>
        client
          .query<{ count: number }>({
            query: `SELECT count() AS count FROM analytics.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
            format: "JSONEachRow",
            query_params: { userId },
          })
          .then((result) => result.json());

      await projectCyclingPower(client, policy, asOf);
      expect((await countObservations())[0]?.count).toBe(0);
      expect((await countMetrics())[0]?.count).toBe(0);
      const afterCompletion = new Date("2026-11-01T16:00:00Z");
      expect(await projectCyclingPower(client, policy, afterCompletion)).toEqual({
        pendingActivities: 0,
      });
      expect((await countMetrics())[0]?.count).toBe(1);
      await projectCyclingPower(client, policy, asOf);
      expect((await countObservations())[0]?.count).toBe(0);
      expect((await countMetrics())[0]?.count).toBe(0);
      await projectCyclingPower(client, policy, afterCompletion);
      expect((await countMetrics())[0]?.count).toBe(1);
    },
  );

  it("keeps missing coverage null and measured zero power available", async () => {
    const userId = randomUUID();
    const missingId = randomUUID();
    const zeroId = randomUUID();
    await seed(userId, [missingId, zeroId], 100, 0);
    await client.command({
      query: `ALTER TABLE analytics.activity_sensor_sample DELETE WHERE activity_id={missingId:UUID} SETTINGS mutations_sync=2`,
      query_params: { missingId },
    });
    expect(await projectCyclingPower(client, policy, asOf)).toEqual({ pendingActivities: 0 });
    const observations = await client
      .query<{ activity_id: string; normalized_power: number | null }>({
        query: `SELECT activity_id,normalized_power FROM analytics.cycling_power_observation_rows FINAL WHERE user_id={userId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId },
      })
      .then((result) => result.json());
    expect(observations.find((row) => row.activity_id === missingId)?.normalized_power).toBeNull();
    expect(observations.find((row) => row.activity_id === zeroId)?.normalized_power).toBe(0);
  });

  it("honors account erasure activated immediately before the observation write", async () => {
    const userId = randomUUID();
    await seed(userId, [randomUUID()]);
    const fence = () =>
      client.command({
        query: `INSERT INTO ingest.account_erasure_fence (user_hash) SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
        query_params: { userId },
      });
    let fenced = false;
    const racingClient: typeof client = {
      ...client,
      exec: async (options) => {
        if (
          !fenced &&
          options.query.startsWith("INSERT INTO analytics.cycling_power_observation_rows")
        ) {
          fenced = true;
          await fence();
        }
        return client.exec(options);
      },
    };
    expect(await projectCyclingPower(racingClient, policy, asOf)).toEqual({ pendingActivities: 0 });
    const result = await client
      .query<{ count: number }>({
        query: `SELECT count() AS count FROM analytics.cycling_power_observation_rows FINAL WHERE user_id={userId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId },
      })
      .then((result) => result.json());
    expect(result[0]?.count).toBe(0);
  });
});
