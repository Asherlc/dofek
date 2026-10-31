import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { TEST_USER_ID } from "dofek/db/schema/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { buildPostgresFitnessRawTableStatements } from "../../../../src/db/clickhouse-raw-tables.ts";
import { buildDailyMetricsReadModelRefreshStatements } from "../../../../src/db/clickhouse-read-models.ts";
import { buildRestingHeartRateSleepWindowTableSql } from "../../../../src/db/clickhouse-resting-heart-rate.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { buildIngestMetricStreamCreateTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { DailyMetricsRepository } from "./daily-metrics-repository.ts";
import {
  dailyMetricsSpo2QueryParams,
  dailyMetricsWithSpo2ClickHouseCte,
} from "./daily-metrics-spo2-query.ts";
import { DataCoverageRepository } from "./data-coverage-repository.ts";
import { restingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

describe("DailyMetricsRepository resting heart rate baseline", () => {
  let testContext: TestContext;
  let repository: DailyMetricsRepository;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    repository = new DailyMetricsRepository(testContext.db, TEST_USER_ID, "UTC", {
      query: async () => [],
    });
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("averages only the preceding seven calendar days when readings have gaps", async () => {
    const rows = await repository.getHrvBaseline(
      10,
      "2026-10-10",
      restingHeartRateValuesCte([
        { date: "2026-10-01", resting_hr: 90 },
        { date: "2026-10-08", resting_hr: 60 },
        { date: "2026-10-10", resting_hr: 54 },
      ]),
    );

    expect(rows.map(({ date, resting_hr_mean_7d }) => ({ date, resting_hr_mean_7d }))).toEqual([
      { date: "2026-10-01", resting_hr_mean_7d: 90 },
      { date: "2026-10-08", resting_hr_mean_7d: 60 },
      { date: "2026-10-10", resting_hr_mean_7d: 57 },
    ]);
  });

  it("includes six-day-old warmup readings and excludes seven-day-old readings on the first requested day", async () => {
    const rows = await repository.getHrvBaseline(
      1,
      "2026-10-10",
      restingHeartRateValuesCte([
        { date: "2026-10-03", resting_hr: 90 },
        { date: "2026-10-04", resting_hr: 60 },
        { date: "2026-10-09", resting_hr: 54 },
        { date: "2026-10-10", resting_hr: 48 },
      ]),
    );

    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-10-10",
        resting_hr: 48,
        resting_hr_mean_7d: 54,
      }),
    ]);
  });

  it("ignores missing readings without carrying values beyond their calendar window", async () => {
    const userId = randomUUID();
    const providerId = `resting-hr-null-${userId}`;
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${userId}::uuid, 'Resting heart rate null fixture')`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${providerId}, 'Daily metrics fixture', ${userId}::uuid)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.daily_metrics (date, provider_id, user_id, hrv)
          VALUES
            ('2026-10-09', ${providerId}, ${userId}::uuid, 45),
            ('2026-10-17', ${providerId}, ${userId}::uuid, 46)`,
    );

    const rows = await new DailyMetricsRepository(testContext.db, userId, "UTC", {
      query: async () => [],
    }).getHrvBaseline(
      11,
      "2026-10-17",
      restingHeartRateValuesCte([
        { date: "2026-10-08", resting_hr: 60 },
        { date: "2026-10-10", resting_hr: 48 },
      ]),
    );

    expect(
      rows.map(({ date, resting_hr, resting_hr_mean_7d }) => ({
        date,
        resting_hr,
        resting_hr_mean_7d,
      })),
    ).toEqual([
      { date: "2026-10-08", resting_hr: 60, resting_hr_mean_7d: 60 },
      { date: "2026-10-09", resting_hr: null, resting_hr_mean_7d: 60 },
      { date: "2026-10-10", resting_hr: 48, resting_hr_mean_7d: 54 },
      { date: "2026-10-17", resting_hr: null, resting_hr_mean_7d: null },
    ]);
  });
});

describe("DailyMetricsRepository sample-derived oxygen saturation", () => {
  let context: TestContext;
  let repository: DailyMetricsRepository;
  let store: Pick<ActivitySensorStore, "query">;
  const client = createClickHouseClientFromEnv();
  const database = `spo2_${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.provider (id,name,user_id) VALUES ('garmin','Garmin',${TEST_USER_ID}),('apple_health','Apple Health',${TEST_USER_ID})`,
    );
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: buildIngestMetricStreamCreateTableSql().replaceAll("ingest.", `${database}.`),
    });
    for (const statement of buildPostgresFitnessRawTableStatements().filter((statement) =>
      /^CREATE TABLE IF NOT EXISTS postgres_fitness\.(daily_metrics|provider_priority|device_priority|sleep_session) \(/.test(
        statement,
      ),
    )) {
      await client.command({ query: statement.replaceAll("postgres_fitness.", `${database}.`) });
    }
    for (const statement of buildDailyMetricsReadModelRefreshStatements()) {
      await client.command({
        query: statement
          .replaceAll("postgres_fitness.", `${database}.`)
          .replaceAll("analytics.", `${database}.`),
      });
    }
    await client.command({
      query: buildRestingHeartRateSleepWindowTableSql().replaceAll("analytics.", `${database}.`),
    });
    await client.command({
      query: `CREATE TABLE ${database}.daily_sleep (user_id UUID,date Date,efficiency_pct Nullable(Float32),source_providers Array(String),is_deleted UInt8,refresh_version UInt64) ENGINE=ReplacingMergeTree(refresh_version) ORDER BY(user_id,date)`,
    });
    store = {
      async query(schema, query, params) {
        const response = await client.query({
          query: query
            .replaceAll("ingest.", `${database}.`)
            .replaceAll("postgres_fitness.", `${database}.`)
            .replaceAll("analytics.", `${database}.`),
          query_params: params,
          format: "JSONEachRow",
        });
        return z.array(schema).parse(await response.json());
      },
    };
    repository = new DailyMetricsRepository(context.db, TEST_USER_ID, "America/Los_Angeles", store);
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar) VALUES
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-20 06:59:00','spo2','garmin',94),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-20 07:00:00','spo2','garmin',96),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-20 07:01:00','spo2','garmin',98)`,
    });
  }, 60_000);

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close();
    await context?.cleanup();
  });

  it("serves sample-only local days through list, latest and trend evidence", async () => {
    expect(
      (await repository.list(2, "2026-10-20")).map(({ date, spo2_avg, source_providers }) => ({
        date,
        spo2_avg,
        source_providers,
      })),
    ).toEqual([
      { date: "2026-10-19", spo2_avg: 94, source_providers: ["garmin"] },
      { date: "2026-10-20", spo2_avg: 97, source_providers: ["garmin"] },
    ]);
    expect(await repository.getLatest()).toMatchObject({ date: "2026-10-20", spo2_avg: 97 });
    expect(await repository.getTrends(2, "2026-10-20")).toMatchObject({
      avg_spo2: 95.5,
      latest_spo2: 97,
      sample_count_spo2: 2,
      metric_evidence: {
        spo2: { latestDate: "2026-10-20", sourceProviders: ["garmin"], observedDays: 2 },
      },
    });
    expect(
      (await repository.listRange("2026-10-19", "2026-10-20")).map((row) => row.spo2_avg),
    ).toEqual([94, 97]);
    const utc = new DailyMetricsRepository(context.db, TEST_USER_ID, "UTC", store);
    expect((await utc.list(1, "2026-10-20"))[0]?.spo2_avg).toBe(96);
  });

  async function readBoth(date: string) {
    const postgres = await repository.list(1, date);
    const clickhouse = await store.query(
      z.object({
        date: z.string(),
        spo2_avg: z.coerce.number().nullable(),
        source_providers: z.array(z.string()),
      }),
      `WITH ${dailyMetricsWithSpo2ClickHouseCte(true)} SELECT toString(date) AS date, spo2_avg, source_providers FROM daily_metrics ORDER BY date`,
      dailyMetricsSpo2QueryParams({
        userId: TEST_USER_ID,
        timezone: "America/Los_Angeles",
        endDate: date,
        days: 1,
      }),
    );
    return [postgres, clickhouse];
  }

  it("uses one current reading per source timestamp and ignores tombstones, invalid readings and other users", async () => {
    const revised = randomUUID();
    const deleted = randomUUID();
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar,version,is_deleted) VALUES
      ('${revised}','${TEST_USER_ID}','2026-10-18 08:00:00','spo2','garmin',20,1,0),
      ('${revised}','${TEST_USER_ID}','2026-10-18 08:00:00','spo2','garmin',96,2,0),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-18 08:00:00','spo2','garmin',96,1,0),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-18 08:01:00','spo2','garmin',100,1,0),
      ('${deleted}','${TEST_USER_ID}','2026-10-18 08:02:00','spo2','garmin',10,1,0),
      ('${deleted}','${TEST_USER_ID}','2026-10-18 08:02:00','spo2','garmin',10,2,1),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-18 08:03:00','spo2','garmin',0,1,0),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-18 08:04:00','spo2','garmin',101,1,0),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-18 08:05:00','spo2','garmin',NULL,1,0),
      (generateUUIDv4(),'${randomUUID()}','2026-10-18 08:01:00','spo2','garmin',10,1,0)`,
    });
    for (const rows of await readBoth("2026-10-18")) {
      expect(rows).toMatchObject([
        { date: "2026-10-18", spo2_avg: 98, source_providers: ["garmin"] },
      ]);
    }
  });

  it("does not let an invalid raw daily summary suppress observed samples", async () => {
    await context.db.execute(sql`INSERT INTO fitness.daily_metrics (user_id,provider_id,date,spo2_avg) VALUES
      (${TEST_USER_ID},'garmin','2026-10-17',0)`);
    await client.command({
      query: `INSERT INTO ${database}.daily_metrics (id,user_id,provider_id,date,spo2_avg) VALUES
      (generateUUIDv4(),'${TEST_USER_ID}','garmin','2026-10-17',0)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar) VALUES
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-17 08:00:00','spo2','garmin',97)`,
    });
    for (const rows of await readBoth("2026-10-17")) expect(rows[0]?.spo2_avg).toBe(97);
  });

  it("normalizes Apple Health fractions by source contract before resolving Garmin percentages", async () => {
    await context.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id,priority,recovery_priority) VALUES ('apple_health',1,1),('garmin',10,10) ON CONFLICT(provider_id) DO UPDATE SET priority=EXCLUDED.priority,recovery_priority=EXCLUDED.recovery_priority`,
    );
    await client.command({
      query: `INSERT INTO ${database}.provider_priority (provider_id,priority,recovery_priority) VALUES ('apple_health',1,1),('garmin',10,10)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar) VALUES
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-16 08:00:00','spo2','apple_health',0.97),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-16 08:01:00','spo2','apple_health',1.1),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-16 08:00:00','spo2','garmin',99)`,
    });
    for (const rows of await readBoth("2026-10-16")) {
      expect(rows[0]?.spo2_avg).toBeCloseTo(97, 4);
      expect(rows[0]?.source_providers).toEqual(["apple_health"]);
    }
  });

  it("retains Garmin percentage units even when the recorded percentage is below one", async () => {
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar)
      VALUES (generateUUIDv4(),'${TEST_USER_ID}','2026-10-11 08:00:00','spo2','garmin',0.98)`,
    });
    for (const rows of await readBoth("2026-10-11")) expect(rows[0]?.spo2_avg).toBeCloseTo(0.98, 6);
  });

  it.each([
    { value: -1, date: "2026-10-10" },
    { value: 101, date: "2026-10-09" },
  ])("ignores invalid raw daily percentage $value", async ({ value, date }) => {
    await context.db.execute(
      sql`INSERT INTO fitness.daily_metrics (user_id,provider_id,date,spo2_avg) VALUES (${TEST_USER_ID},'garmin',${date},${value})`,
    );
    await client.command({
      query: `INSERT INTO ${database}.daily_metrics (id,user_id,provider_id,date,spo2_avg)
      VALUES (generateUUIDv4(),'${TEST_USER_ID}','garmin','${date}',${value})`,
    });
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar)
      VALUES (generateUUIDv4(),'${TEST_USER_ID}','${date} 08:00:00','spo2','garmin',97)`,
    });
    for (const rows of await readBoth(date)) expect(rows[0]?.spo2_avg).toBe(97);
  });

  it("selects a higher-priority raw summary and retains its other daily fields", async () => {
    await context.db.execute(sql`INSERT INTO fitness.daily_metrics (user_id,provider_id,date,spo2_avg,hrv,steps)
      VALUES (${TEST_USER_ID},'apple_health','2026-10-15',95,42,1234)`);
    await client.command({
      query: `INSERT INTO ${database}.daily_metrics (id,user_id,provider_id,date,spo2_avg,hrv,steps)
      VALUES (generateUUIDv4(),'${TEST_USER_ID}','apple_health','2026-10-15',95,42,1234)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar)
      VALUES (generateUUIDv4(),'${TEST_USER_ID}','2026-10-15 08:00:00','spo2','garmin',99)`,
    });
    for (const rows of await readBoth("2026-10-15")) expect(rows[0]?.spo2_avg).toBe(95);
    expect((await repository.list(1, "2026-10-15"))[0]).toMatchObject({
      hrv: 42,
      steps: 1234,
      source_providers: ["apple_health"],
    });

    await context.db.execute(
      sql`UPDATE fitness.provider_priority SET recovery_priority=0 WHERE provider_id='garmin'`,
    );
    await client.command({
      query: `INSERT INTO ${database}.provider_priority (provider_id,priority,recovery_priority,_peerdb_version)
      VALUES ('garmin',10,0,2)`,
    });
    for (const rows of await readBoth("2026-10-15")) expect(rows[0]?.spo2_avg).toBe(99);
  });

  it("prefers a same-source raw daily average over its sampled average", async () => {
    await context.db.execute(sql`INSERT INTO fitness.daily_metrics (user_id,provider_id,date,spo2_avg)
      VALUES (${TEST_USER_ID},'garmin','2026-10-14',96)`);
    await client.command({
      query: `INSERT INTO ${database}.daily_metrics (id,user_id,provider_id,date,spo2_avg)
      VALUES (generateUUIDv4(),'${TEST_USER_ID}','garmin','2026-10-14',96)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar)
      VALUES (generateUUIDv4(),'${TEST_USER_ID}','2026-10-14 08:00:00','spo2','garmin',99)`,
    });
    for (const rows of await readBoth("2026-10-14")) expect(rows[0]?.spo2_avg).toBe(96);
  });

  it("honors device recovery priority and the longest matching source label", async () => {
    await context.db.execute(sql`INSERT INTO fitness.device_priority (provider_id,source_name_pattern,recovery_priority)
      VALUES ('apple_health','Test Watch%',20),('apple_health','Test Watch Special%',-1)`);
    await client.command({
      query: `INSERT INTO ${database}.device_priority (provider_id,source_name_pattern,recovery_priority)
      VALUES ('apple_health','Test Watch%',20),('apple_health','Test Watch Special%',-1)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,device_id,scalar)
      VALUES (generateUUIDv4(),'${TEST_USER_ID}','2026-10-13 08:00:00','spo2','apple_health','Test Watch Special Edition',0.98),
      (generateUUIDv4(),'${TEST_USER_ID}','2026-10-13 08:00:00','spo2','garmin',NULL,99)`,
    });
    for (const rows of await readBoth("2026-10-13")) {
      expect(rows[0]?.spo2_avg).toBeCloseTo(98, 4);
      expect(rows[0]?.source_providers).toEqual(["apple_health"]);
    }
  });

  it("removes a sample-only day after its last current reading is deleted", async () => {
    const id = randomUUID();
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar,version,is_deleted)
      VALUES ('${id}','${TEST_USER_ID}','2026-10-12 08:00:00','spo2','garmin',97,1,0)`,
    });
    for (const rows of await readBoth("2026-10-12")) expect(rows[0]?.spo2_avg).toBe(97);
    await client.command({
      query: `INSERT INTO ${database}.metric_stream (id,user_id,recorded_at,channel,provider_id,scalar,version,is_deleted)
      VALUES ('${id}','${TEST_USER_ID}','2026-10-12 08:00:00','spo2','garmin',97,2,1)`,
    });
    for (const rows of await readBoth("2026-10-12")) expect(rows).toEqual([]);
  });

  it("applies access windows to sample-only list, latest, exact ranges and trend evidence", async () => {
    const limited = new DailyMetricsRepository(
      context.db,
      TEST_USER_ID,
      "America/Los_Angeles",
      store,
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-10-19",
        endDateExclusive: "2026-10-20",
      },
    );
    expect((await limited.list(30, "2026-10-20")).map((row) => row.date)).toEqual(["2026-10-19"]);
    expect(await limited.getLatest()).toMatchObject({ date: "2026-10-19", spo2_avg: 94 });
    expect((await limited.listRange("2026-10-01", "2026-10-20")).map((row) => row.date)).toEqual([
      "2026-10-19",
    ]);
    expect(await limited.getTrends(30, "2026-10-20")).toMatchObject({
      latest_spo2: 94,
      sample_count_spo2: 1,
      metric_evidence: { spo2: { observedDays: 1, latestDate: "2026-10-19" } },
    });
  });

  it("serves canonical sample dates and provider attribution through the MCP coverage inventory", async () => {
    const inventory = await new DataCoverageRepository(
      store,
      TEST_USER_ID,
      "America/Los_Angeles",
    ).list();
    expect(inventory.find((row) => row.metric === "spo2")).toEqual({
      metric: "spo2",
      first_observed: "2026-10-09",
      last_observed: "2026-10-20",
      total_days_observed: 11,
      source_providers: ["apple_health", "garmin"],
    });
    expect(inventory.find((row) => row.metric === "steps")).toMatchObject({
      total_days_observed: 1,
    });
    const empty = await new DataCoverageRepository(
      store,
      randomUUID(),
      "America/Los_Angeles",
    ).list();
    expect(empty).toHaveLength(10);
    for (const row of empty) {
      expect(row).toMatchObject({
        first_observed: null,
        last_observed: null,
        total_days_observed: 0,
        source_providers: [],
      });
    }
  });
  it("resolves delayed WHOOP BLE temperature against API priority on both query engines", async () => {
    const frameHex =
      readFileSync(
        new URL(
          "../../../mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv",
          import.meta.url,
        ),
        "utf8",
      )
        .split("\n")
        .map((line) => line.split("\t").at(-1) ?? "")
        .find((hex) => hex.length === 248 && hex.slice(16, 20) === "2f12") ?? "";
    await client.insert({
      table: `${database}.metric_stream`,
      format: "JSONEachRow",
      values: [
        {
          id: randomUUID(),
          user_id: TEST_USER_ID,
          provider_id: "whoop_ble",
          device_id: "strap-a",
          recorded_at: "2026-10-30 12:00:00.000",
          channel: "sensor_record",
          source_type: "ble",
          metadata: JSON.stringify({
            captureId: randomUUID(),
            timestamp: "2026-10-30T12:00:00.000Z",
            frameHex,
            deviceInfo: {},
          }),
        },
      ],
    });
    const readTemperature = async () => {
      const pg = await repository.list(1, "2026-03-29");
      const ch = await store.query(
        z.object({ skin_temp_c: z.coerce.number().nullable() }),
        `WITH ${dailyMetricsWithSpo2ClickHouseCte(true)} SELECT skin_temp_c FROM daily_metrics`,
        dailyMetricsSpo2QueryParams({
          userId: TEST_USER_ID,
          timezone: "America/Los_Angeles",
          endDate: "2026-03-29",
          days: 1,
        }),
      );
      return [pg[0]?.skin_temp_c, ch[0]?.skin_temp_c];
    };
    for (const value of await readTemperature()) expect(value).toBeCloseTo(32.18, 3);
    await context.db.execute(sql`INSERT INTO fitness.daily_metrics (user_id,provider_id,date,skin_temp_c)
      VALUES (${TEST_USER_ID},'garmin','2026-03-29',34.5)`);
    await client.command({
      query: `INSERT INTO ${database}.daily_metrics (id,user_id,provider_id,date,skin_temp_c)
      VALUES (generateUUIDv4(),'${TEST_USER_ID}','garmin','2026-03-29',34.5)`,
    });
    await context.db.execute(sql`INSERT INTO fitness.provider_priority (provider_id,priority,recovery_priority)
      VALUES ('whoop_ble',1,1),('garmin',10,10) ON CONFLICT(provider_id) DO UPDATE SET priority=EXCLUDED.priority,recovery_priority=EXCLUDED.recovery_priority`);
    await client.command({
      query: `INSERT INTO ${database}.provider_priority (provider_id,priority,recovery_priority,_peerdb_version)
      VALUES ('whoop_ble',1,1,10),('garmin',10,10,10)`,
    });
    for (const value of await readTemperature()) expect(value).toBeCloseTo(32.18, 3);
    await context.db.execute(
      sql`UPDATE fitness.provider_priority SET recovery_priority=0 WHERE provider_id='garmin'`,
    );
    await client.command({
      query: `INSERT INTO ${database}.provider_priority (provider_id,priority,recovery_priority,_peerdb_version)
      VALUES ('garmin',10,0,20)`,
    });
    for (const value of await readTemperature()) expect(value).toBe(34.5);
  });
});
