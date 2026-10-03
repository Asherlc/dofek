import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { buildIngestMetricStreamCreateTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";
import { HeartRateRepository } from "./heart-rate-repository.ts";
import {
  type HeartRateFixtureRow,
  heartRateFixtureReader,
  insertHeartRateFixtureRows,
  legacyDailyHeartRateQuery,
} from "./heart-rate-repository-test-helpers.ts";

const explainSchema = z.array(z.object({ explain: z.string() }));
const queryLogSchema = z.array(
  z.object({
    query_id: z.string(),
    read_rows: z.coerce.number(),
    read_bytes: z.coerce.number(),
    query_duration_ms: z.coerce.number(),
    projections: z.array(z.string()),
  }),
);

describe("HeartRateRepository (integration)", () => {
  const client = createClickHouseClientFromEnv();
  const database = `heart_rate_${randomUUID().replaceAll("-", "")}`;
  const table = `${database}.metric_stream`;
  const userId = randomUUID();
  const otherUserId = randomUUID();
  let lastQuery = "";
  let lastParams: Record<string, unknown> | undefined;
  const reader = heartRateFixtureReader(client, table, (query, params) => {
    lastQuery = query;
    lastParams = params;
  });

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: buildIngestMetricStreamCreateTableSql().replaceAll("ingest.metric_stream", table),
    });
    await client.command({ query: `SYSTEM STOP MERGES ${table}` });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });

  it("preserves complete identities, replay, deleted/invalid winners and equal-version ties before and after merges", async () => {
    const rows: HeartRateFixtureRow[] = [
      {
        id: randomUUID(),
        user_id: userId,
        provider_id: "whoop_ble",
        recorded_at: "2026-04-12 10:00:00.000",
        scalar: 72,
      },
      {
        id: randomUUID(),
        user_id: userId,
        provider_id: "whoop_ble",
        recorded_at: "2026-04-12 10:00:30.000",
        scalar: 76,
      },
      {
        id: randomUUID(),
        user_id: userId,
        provider_id: "whoop_ble",
        recorded_at: "2026-04-12 10:01:00.000",
        scalar: 80,
      },
      {
        id: randomUUID(),
        user_id: userId,
        provider_id: "apple_health",
        recorded_at: "2026-04-12 10:00:30.000",
        scalar: 70,
      },
      {
        id: randomUUID(),
        user_id: otherUserId,
        provider_id: "other_user",
        recorded_at: "2026-04-12 10:00:00.000",
        scalar: 200,
      },
      {
        id: randomUUID(),
        user_id: userId,
        provider_id: "other_channel",
        recorded_at: "2026-04-12 10:00:00.000",
        scalar: 200,
        channel: "power",
      },
    ];
    const identityId = randomUUID();
    rows.push(
      ...[null, randomUUID(), randomUUID()].map((activity_id, index) => ({
        id: identityId,
        user_id: userId,
        activity_id,
        provider_id: "identity",
        recorded_at: "2026-04-12 12:00:00.000",
        scalar: 60 + index * 40,
      })),
    );
    const replay = rows[0];
    if (!replay) throw new Error("Missing replay fixture");
    await insertHeartRateFixtureRows(client, table, [...rows, replay]);
    for (const replacement of [
      { scalar: 88, is_deleted: 1 as const },
      { scalar: 0, is_deleted: 0 as const },
      { scalar: null, is_deleted: 0 as const },
    ]) {
      const row = {
        id: randomUUID(),
        user_id: userId,
        provider_id: "invalid",
        recorded_at: "2026-04-12 13:00:00.000",
        scalar: 90,
      };
      await insertHeartRateFixtureRows(client, table, [row]);
      await insertHeartRateFixtureRows(client, table, [{ ...row, ...replacement, version: 2 }]);
    }
    const renamed = {
      id: randomUUID(),
      user_id: userId,
      provider_id: "previous_source",
      recorded_at: "2026-04-12 14:00:00.000",
      scalar: 40,
    };
    await insertHeartRateFixtureRows(client, table, [renamed]);
    await insertHeartRateFixtureRows(client, table, [
      { ...renamed, provider_id: "current_source", scalar: 90, version: 2 },
    ]);
    const tied = {
      id: randomUUID(),
      user_id: userId,
      provider_id: "tie",
      recorded_at: "2026-04-12 15:00:00.000",
      scalar: 60,
    };
    await insertHeartRateFixtureRows(client, table, [tied]);
    await insertHeartRateFixtureRows(client, table, [{ ...tied, scalar: 100 }]);
    const verify = async () => {
      const actual = await new HeartRateRepository(reader, userId, "UTC").dailyBySource(
        "2026-04-12",
      );
      const bySource = Object.fromEntries(actual.map((series) => [series.providerId, series]));
      expect(Object.keys(bySource).sort()).toEqual([
        "apple_health",
        "current_source",
        "identity",
        "tie",
        "whoop_ble",
      ]);
      expect(bySource.whoop_ble).toEqual(
        expect.objectContaining({
          sampleCount: 2,
          minHeartRate: 74,
          avgHeartRate: 77,
          maxHeartRate: 80,
          samples: [
            { time: "2026-04-12T10:00:00.000Z", heartRate: 74 },
            { time: "2026-04-12T10:01:00.000Z", heartRate: 80 },
          ],
        }),
      );
      for (const [source, value] of [
        ["apple_health", 70],
        ["current_source", 90],
        ["identity", 100],
        ["tie", 100],
      ] as const)
        expect(bySource[source]).toEqual(
          expect.objectContaining({
            sampleCount: 1,
            minHeartRate: value,
            avgHeartRate: value,
            maxHeartRate: value,
          }),
        );
      const baseline = await client.query({
        query: legacyDailyHeartRateQuery.replaceAll("ingest.metric_stream", table),
        query_params: lastParams,
        format: "JSONEachRow",
      });
      const current = await client.query({
        query: lastQuery,
        query_params: lastParams,
        format: "JSONEachRow",
      });
      expect(await current.json()).toEqual(await baseline.json());
    };
    await verify();
    await client.command({ query: `SYSTEM START MERGES ${table}` });
    await client.command({ query: `OPTIMIZE TABLE ${table} FINAL` });
    await verify();
  });

  it.each([
    {
      date: "2026-03-08",
      start: "2026-03-08 08:00:00.000",
      end: "2026-03-09 07:00:00.000",
      before: "2026-03-08 07:59:59.000",
      last: "2026-03-09 06:59:59.000",
    },
    {
      date: "2026-11-01",
      start: "2026-11-01 07:00:00.000",
      end: "2026-11-02 08:00:00.000",
      before: "2026-11-01 06:59:59.000",
      last: "2026-11-02 07:59:59.000",
    },
  ])(
    "uses exact local-day bounds on DST transition $date",
    async ({ date, start, end, before, last }) => {
      await insertHeartRateFixtureRows(
        client,
        table,
        [before, start, last, end].map((recorded_at, index) => ({
          id: randomUUID(),
          user_id: userId,
          provider_id: "dst",
          recorded_at,
          scalar: 60 + index * 10,
        })),
      );
      const result = await new HeartRateRepository(
        reader,
        userId,
        "America/Los_Angeles",
      ).dailyBySource(date);
      expect(result).toEqual([
        expect.objectContaining({
          providerId: "dst",
          sampleCount: 2,
          minHeartRate: 70,
          avgHeartRate: 75,
          maxHeartRate: 80,
          samples: [
            { time: `${start.replace(" ", "T")}Z`, heartRate: 70 },
            { time: `${last.slice(0, 16).replace(" ", "T")}:00.000Z`, heartRate: 80 },
          ],
        }),
      ]);
    },
  );

  it("selects the day projection normally and bounds FINAL reads to candidate raw keys", async () => {
    const scaledTable = `${database}.scaled_metric_stream`;
    await client.command({ query: `DROP TABLE IF EXISTS ${scaledTable}` });
    await client.command({
      query: buildIngestMetricStreamCreateTableSql().replaceAll(
        "ingest.metric_stream",
        scaledTable,
      ),
    });
    await client.command({
      query: `INSERT INTO ${scaledTable} (id, user_id, activity_id, channel, recorded_at, provider_id, scalar)
      SELECT toUUID(MD5(toString(number))), {userId:UUID},
        multiIf(number % 4 < 2, NULL, number % 4 = 2, toUUID(MD5('all-day-activity')),
          toUUID(MD5(toString(intDiv(number, 1000))))),
        if(number < 100000, 'heart_rate', 'power'),
        toDateTime64('2026-01-01 00:00:00', 6, 'UTC') + toIntervalDay(intDiv(number, 1000) % 100),
        'scaled', 60 + number % 80 FROM numbers(200000)`,
      query_params: { userId },
    });
    let boundedQuery = "";
    let params: Record<string, unknown> | undefined;
    const scaledReader = heartRateFixtureReader(client, scaledTable, (query, queryParams) => {
      boundedQuery = query;
      params = queryParams;
    });
    await new HeartRateRepository(scaledReader, userId, "UTC").dailyBySource("2026-04-01");
    const explain = await client.query({
      query: `EXPLAIN indexes = 1, projections = 1 ${boundedQuery}`,
      query_params: params,
      format: "JSONEachRow",
    });
    const plan = explainSchema
      .parse(await explain.json())
      .map(({ explain }) => explain)
      .join("\n");
    expect(plan).toContain(`ReadFromMergeTree (${scaledTable})`);
    expect(plan).toMatch(/in \d+-element set/);
    const finalGranules = plan.match(/Granules: (\d+)\/(\d+)/);
    expect(Number(finalGranules?.[1])).toBeLessThan(Number(finalGranules?.[2]));
    // EXPLAIN omits the CreatingSets subqueries; inspect the exact candidate CTE
    // separately, and verify the complete query's executed projection below.
    const candidates = boundedQuery.slice(0, boundedQuery.indexOf("), winning_rows AS"));
    const candidateExplain = await client.query({
      query: `EXPLAIN indexes = 1, projections = 1 ${candidates}) SELECT * FROM candidate_keys`,
      query_params: params,
      format: "JSONEachRow",
    });
    const candidatePlan = explainSchema
      .parse(await candidateExplain.json())
      .map(({ explain }) => explain)
      .join("\n");
    expect(candidatePlan).toContain("by_user_channel_recorded_at");
    const queryIds = { baseline: randomUUID(), bounded: randomUUID() };
    const baseline = await client.query({
      query: legacyDailyHeartRateQuery.replaceAll("ingest.metric_stream", scaledTable),
      query_params: params,
      query_id: queryIds.baseline,
      format: "JSONEachRow",
      clickhouse_settings: { use_query_cache: 0 },
    });
    const bounded = await client.query({
      query: boundedQuery,
      query_params: params,
      query_id: queryIds.bounded,
      format: "JSONEachRow",
      clickhouse_settings: { use_query_cache: 0 },
    });
    expect(await bounded.json()).toEqual(await baseline.json());
    await client.command({ query: "SYSTEM FLUSH LOGS" });
    const logs = await client.query({
      query: `SELECT query_id, read_rows, read_bytes, query_duration_ms, projections FROM system.query_log WHERE type = 'QueryFinish' AND query_id IN {ids:Array(String)}`,
      query_params: { ids: Object.values(queryIds) },
      format: "JSONEachRow",
    });
    const byId = Object.fromEntries(
      queryLogSchema.parse(await logs.json()).map((row) => [row.query_id, row]),
    );
    expect(byId[queryIds.bounded]?.projections).toContain(
      `${scaledTable}.by_user_channel_recorded_at`,
    );
    expect(byId[queryIds.bounded]?.read_rows).toBeLessThan(byId[queryIds.baseline]?.read_rows ?? 0);
    expect(byId[queryIds.bounded]?.read_bytes).toBeLessThan(
      byId[queryIds.baseline]?.read_bytes ?? 0,
    );
    await client.command({ query: `OPTIMIZE TABLE ${scaledTable} FINAL` });
    const mergedBaseline = await client.query({
      query: legacyDailyHeartRateQuery.replaceAll("ingest.metric_stream", scaledTable),
      query_params: params,
      format: "JSONEachRow",
    });
    const mergedBounded = await client.query({
      query: boundedQuery,
      query_params: params,
      format: "JSONEachRow",
    });
    expect(await mergedBounded.json()).toEqual(await mergedBaseline.json());
  });
});
