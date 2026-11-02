import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ClickHouseClient, createClickHouseClientFromEnv } from "../db/clickhouse.ts";
import { cyclingPowerSchemaStatements } from "../db/cycling-power-schema.ts";
import { buildAccountErasureFenceTableSql } from "../metric-stream/clickhouse-table.ts";
import { projectCyclingPower } from "./cycling-power-projector.ts";

const policy = {
  coveragePolicy: {
    maximumHoldSeconds: 10,
    minimumGapSeconds: 5,
    gapIntervalMultiplier: 2,
    maximumGapSeconds: 10,
  },
  referenceCurves: [
    { criticalPowerWatts: 100, workCapacityJoules: 6000, timeOffsetSeconds: 60 },
    { criticalPowerWatts: 300, workCapacityJoules: 6000, timeOffsetSeconds: 60 },
  ],
  thresholdPolicy: {
    minimumDurationSeconds: 60,
    maximumDurationSeconds: 60,
    targetDurationSeconds: 3600,
  },
  historyPolicy: { comparisonWindowDays: 14, minimumHistoryDays: 28, maximumDailyDecayFraction: 0 },
  modelVersion: "fixture-v1",
};

describe("cycling power projector", () => {
  const real = createClickHouseClientFromEnv();
  const database = `cycling_projector_${randomUUID().replaceAll("-", "")}`;
  const rewrite = (query: string) =>
    query
      .replaceAll("analytics.", `${database}.`)
      .replaceAll("ingest.account_erasure_fence", `${database}.account_erasure_fence`);
  const insert = real.insert;
  if (!insert) throw new Error("Test client requires insert support");
  const client = {
    command: (options) => real.command({ ...options, query: rewrite(options.query) }),
    query: (options) => real.query({ ...options, query: rewrite(options.query) }),
    insert: (options) => insert.call(real, { ...options, table: rewrite(options.table) }),
  } satisfies ClickHouseClient;
  const asOf = new Date("2026-11-01T12:00:00Z");
  beforeAll(async () => {
    await real.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: buildAccountErasureFenceTableSql() });
    for (const statement of cyclingPowerSchemaStatements())
      await client.command({ query: statement });
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
  });
  beforeEach(async () => {
    for (const table of [
      "account_erasure_fence",
      "activity_summary_rows",
      "activity_sensor_sample",
      "activity_power_curve",
      "cycling_power_observation_rows",
      "cycling_power_history_rows",
    ]) {
      await client.command({ query: `TRUNCATE TABLE analytics.${table}` });
    }
  });
  afterAll(async () => {
    await real.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await real.close?.();
  });

  async function seed(
    userId: string,
    ids: string[],
    version = 100,
    watts = 250,
    canonicalType = "cycling",
  ) {
    await client.insert({
      table: "analytics.activity_summary_rows",
      format: "JSONEachRow",
      values: ids.map((id) => ({
        user_id: userId,
        activity_id: id,
        started_at: "2026-10-31 10:00:00",
        ended_at: "2026-10-31 10:01:00",
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
          recorded_at: `2026-10-31 10:00:${String(second).padStart(2, "0")}`,
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

  it("publishes one compact observation batch while keeping native reads bounded per activity", async () => {
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
      command: (options) => {
        if (options.query.startsWith("INSERT INTO analytics.cycling_power_observation_rows"))
          observationWrites += 1;
        return client.command(options);
      },
    };
    expect(await projectCyclingPower(measuredClient, policy, asOf)).toMatchObject({
      pendingActivities: 1,
      projectedUsers: 0,
    });
    expect(nativeReads).toBe(100);
    expect(observationWrites).toBe(1);
    expect(await projectCyclingPower(client, policy, asOf)).toMatchObject({
      pendingActivities: 0,
      pendingUsers: 0,
      projectedUsers: 1,
    });
  });

  it("converges across the 32-user bound again after daily rollover", async () => {
    await client.insert({
      table: "analytics.activity_summary_rows",
      format: "JSONEachRow",
      values: Array.from({ length: 33 }, () => ({
        user_id: randomUUID(),
        activity_id: randomUUID(),
        started_at: "2026-10-31 10:00:00",
        ended_at: "2026-10-31 10:01:00",
        canonical_type: "cycling",
        power_sample_count: 0,
        refresh_version: 100,
        is_deleted: 0,
      })),
    });
    for (const day of [asOf, new Date("2026-11-02T12:00:00Z")]) {
      expect(await projectCyclingPower(client, policy, day)).toMatchObject({
        pendingActivities: 0,
        pendingUsers: 1,
        projectedUsers: 32,
      });
      expect(await projectCyclingPower(client, policy, day)).toMatchObject({
        pendingActivities: 0,
        pendingUsers: 0,
        projectedUsers: 1,
      });
    }
  });

  it.each(["11:00:00", "15:00:00"])(
    "admits a ride only when completed, including same-day maturity and rewind (%s)",
    async (startTime) => {
      const userId = randomUUID();
      const id = randomUUID();
      await seed(userId, [id]);
      await client.insert({
        table: "analytics.activity_summary_rows",
        format: "JSONEachRow",
        values: [
          {
            user_id: userId,
            activity_id: id,
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
      expect(await projectCyclingPower(client, policy, afterCompletion)).toMatchObject({
        pendingActivities: 0,
        pendingUsers: 0,
        projectedUsers: 1,
      });
      expect((await countMetrics())[0]?.count).toBe(1);
      await projectCyclingPower(client, policy, asOf);
      expect((await countObservations())[0]?.count).toBe(0);
      expect((await countMetrics())[0]?.count).toBe(0);
      await projectCyclingPower(client, policy, afterCompletion);
      expect((await countMetrics())[0]?.count).toBe(1);
    },
  );

  it("projects native power and replays corrected and deleted effort evidence", async () => {
    const userId = randomUUID();
    const id = randomUUID();
    await seed(userId, [id]);
    expect(await projectCyclingPower(client, policy, asOf)).toMatchObject({
      pendingActivities: 0,
      pendingUsers: 0,
      projectedUsers: 1,
    });
    const read = () =>
      client
        .query<{ normalized_power: number; eftp: number; power_tss: number }>({
          query: `SELECT normalized_power,eftp,power_tss FROM analytics.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
          format: "JSONEachRow",
          query_params: { userId },
        })
        .then((result) => result.json());
    expect((await read())[0]).toMatchObject({ normalized_power: 250 });
    expect((await read())[0]?.eftp).toBeCloseTo(201.6393442623, 6);
    await seed(userId, [id], 200, 300);
    await projectCyclingPower(client, policy, asOf);
    expect((await read())[0]?.normalized_power).toBe(300);
    expect((await read())[0]?.eftp).toBeCloseTo(251.6393442623, 6);
    await client.insert({
      table: "analytics.activity_summary_rows",
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: id,
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

  it("caps changed native activities and never publishes an incomplete user", async () => {
    const userId = randomUUID();
    await seed(
      userId,
      Array.from({ length: 101 }, () => randomUUID()),
    );
    expect(await projectCyclingPower(client, policy, asOf)).toMatchObject({
      pendingActivities: 1,
      pendingUsers: 1,
      projectedUsers: 0,
    });
    expect(await projectCyclingPower(client, policy, asOf)).toMatchObject({
      pendingActivities: 0,
      pendingUsers: 0,
      projectedUsers: 1,
    });
  });

  it("refreshes running NP without adding running effort to cycling history", async () => {
    const userId = randomUUID();
    const cyclingId = randomUUID();
    const runningId = randomUUID();
    await seed(userId, [cyclingId]);
    await projectCyclingPower(client, policy, asOf);
    await seed(userId, [runningId], 200, 300, "running");
    expect(await projectCyclingPower(client, policy, asOf)).toMatchObject({
      pendingActivities: 0,
      pendingUsers: 0,
      projectedUsers: 1,
    });
    const history = await client
      .query<{ activity_id: string; eftp: number }>({
        query: `SELECT activity_id,eftp FROM analytics.cycling_activity_power_metrics WHERE user_id={userId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId },
      })
      .then((result) => result.json());
    expect(history).toHaveLength(1);
    expect(history[0]?.activity_id).toBe(cyclingId);
    expect(history[0]?.eftp).toBeCloseTo(201.6393442623, 6);
    const observations = await client
      .query<{ normalized_power: number }>({
        query: `SELECT normalized_power FROM analytics.cycling_power_observation_rows FINAL WHERE user_id={userId:UUID} AND activity_id={runningId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId, runningId },
      })
      .then((result) => result.json());
    expect(observations[0]?.normalized_power).toBe(300);
  });

  it("limits compact-history publication to 32 ready users", async () => {
    for (let index = 0; index < 33; index += 1) await seed(randomUUID(), [randomUUID()]);
    expect(await projectCyclingPower(client, policy, asOf)).toMatchObject({
      pendingActivities: 0,
      pendingUsers: 1,
      projectedUsers: 32,
    });
    expect(await projectCyclingPower(client, policy, asOf)).toMatchObject({
      pendingActivities: 0,
      pendingUsers: 0,
      projectedUsers: 1,
    });
  });

  it("treats a negative native watt sentinel as a missing-coverage barrier", async () => {
    const userId = randomUUID();
    const id = randomUUID();
    await seed(userId, [id]);
    await client.insert({
      table: "analytics.activity_sensor_sample",
      format: "JSONEachRow",
      values: [
        {
          user_id: userId,
          activity_id: id,
          recorded_at: "2026-10-31 10:00:30",
          channel: "power",
          scalar: -1,
          refresh_version: 200,
          is_deleted: 0,
        },
      ],
    });
    await expect(projectCyclingPower(client, policy, asOf)).resolves.toMatchObject({
      pendingActivities: 0,
      pendingUsers: 0,
      projectedUsers: 1,
    });
    const observations = await client
      .query<{ normalized_power: number | null }>({
        query: `SELECT normalized_power FROM analytics.cycling_power_observation_rows FINAL WHERE user_id={userId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId },
      })
      .then((result) => result.json());
    expect(observations[0]?.normalized_power).toBeNull();
  });

  it("records missing cycling power as unknown while preserving recorded zero watts", async () => {
    const userId = randomUUID();
    const missingId = randomUUID();
    const zeroId = randomUUID();
    await seed(userId, [missingId, zeroId], 100, 0);
    await client.command({
      query: `ALTER TABLE analytics.activity_sensor_sample DELETE WHERE activity_id={missingId:UUID} SETTINGS mutations_sync=2`,
      query_params: { missingId },
    });
    expect(await projectCyclingPower(client, policy, asOf)).toMatchObject({
      pendingActivities: 0,
      pendingUsers: 0,
    });
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

  it.each(["cycling_power_observation_rows", "cycling_power_history_rows"])(
    "honors erasure activated immediately before writing %s",
    async (table) => {
      const userId = randomUUID();
      await seed(userId, [randomUUID()]);
      const fence = () =>
        client.command({
          query: `INSERT INTO ingest.account_erasure_fence (user_hash) SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
          query_params: { userId },
        });
      const racingClient = {
        ...client,
        command: async (options: Parameters<typeof client.command>[0]) => {
          if (options.query.startsWith(`INSERT INTO analytics.${table}`)) await fence();
          return client.command(options);
        },
        insert: async (options: Parameters<typeof client.insert>[0]) => {
          if (options.table === `analytics.${table}`) await fence();
          return client.insert(options);
        },
      };
      expect(await projectCyclingPower(racingClient, policy, asOf)).toMatchObject({
        projectedUsers: 0,
      });
      const result = await client
        .query<{ count: number }>({
          query: `SELECT count() AS count FROM analytics.${table} FINAL WHERE user_id={userId:UUID}`,
          format: "JSONEachRow",
          query_params: { userId },
        })
        .then((result) => result.json());
      expect(result[0]?.count).toBe(0);
    },
  );

  it("advances clock-only history without scanning unchanged native power", async () => {
    const userId = randomUUID();
    await seed(userId, [randomUUID()]);
    await projectCyclingPower(client, policy, asOf);
    const before = await client
      .query<{ refresh_version: string }>({
        query: `SELECT toString(refresh_version) AS refresh_version FROM analytics.cycling_power_observation_rows FINAL WHERE user_id={userId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId },
      })
      .then((result) => result.json());
    const next = new Date("2026-11-02T12:00:00Z");
    expect(await projectCyclingPower(client, policy, next)).toMatchObject({
      pendingActivities: 0,
      pendingUsers: 0,
      projectedUsers: 1,
    });
    const after = await client
      .query<{ refresh_version: string }>({
        query: `SELECT toString(refresh_version) AS refresh_version FROM analytics.cycling_power_observation_rows FINAL WHERE user_id={userId:UUID}`,
        format: "JSONEachRow",
        query_params: { userId },
      })
      .then((result) => result.json());
    expect(after).toEqual(before);
  });
});
