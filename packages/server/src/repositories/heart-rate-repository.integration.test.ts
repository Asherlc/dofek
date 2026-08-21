import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../../../../src/db/clickhouse-metric-stream-bootstrap.ts";
import { HeartRateRepository, type MetricStreamClickHouseReader } from "./heart-rate-repository.ts";
import {
  type MetricStreamSeedRow,
  seedMetricStreamRows,
} from "./metric-stream-integration-test-helpers.ts";

const testUserId = "00000000-0000-0000-0000-0000000000a1";

const client = createClickHouseClientFromEnv();

const reader: MetricStreamClickHouseReader = {
  async query(schema, query, params) {
    if (!client.query) throw new Error("ClickHouse client must support query");
    const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
    const rows = await result.json();
    return rows.map((row) => schema.parse(row));
  },
};

async function seed(rows: MetricStreamSeedRow[]): Promise<void> {
  await seedMetricStreamRows(client, testUserId, rows);
}

describe("HeartRateRepository (integration)", () => {
  beforeAll(async () => {
    for (const statement of buildClickHouseBootstrapStatementsForNativeMetricStream("")) {
      await client.command({ query: statement });
    }
    await client.command({
      query: `ALTER TABLE ingest.metric_stream
        DELETE WHERE user_id = {userId:UUID}
        SETTINGS mutations_sync = 1`,
      query_params: { userId: testUserId },
    });

    const supersededId = randomUUID();
    await seed([
      // whoop_ble: two minutes of data
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:00:00.000",
        provider_id: "whoop_ble",
        channel: "heart_rate",
        scalar: 72,
        is_deleted: 0,
        version: 0,
      },
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:01:00.000",
        provider_id: "whoop_ble",
        channel: "heart_rate",
        scalar: 74,
        is_deleted: 0,
        version: 0,
      },
      // apple_health: same minute as whoop — must stay a separate source (no priority collapse)
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:00:30.000",
        provider_id: "apple_health",
        channel: "heart_rate",
        scalar: 70,
        is_deleted: 0,
        version: 0,
      },
      // version dedup: same id/time, v1 supersedes v0 — FINAL must keep 99, not 50
      {
        id: supersededId,
        recorded_at: "2026-04-12 11:00:00.000",
        provider_id: "whoop_ble",
        channel: "heart_rate",
        scalar: 50,
        is_deleted: 0,
        version: 0,
      },
      {
        id: supersededId,
        recorded_at: "2026-04-12 11:00:00.000",
        provider_id: "whoop_ble",
        channel: "heart_rate",
        scalar: 99,
        is_deleted: 0,
        version: 1,
      },
      // excluded rows
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 12:00:00.000",
        provider_id: "whoop_ble",
        channel: "heart_rate",
        scalar: 88,
        is_deleted: 1,
        version: 1,
      }, // deleted
      {
        id: randomUUID(),
        recorded_at: "2026-04-11 10:00:00.000",
        provider_id: "whoop_ble",
        channel: "heart_rate",
        scalar: 60,
        is_deleted: 0,
        version: 0,
      }, // other day
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 13:00:00.000",
        provider_id: "whoop_ble",
        channel: "heart_rate",
        scalar: 0,
        is_deleted: 0,
        version: 0,
      }, // zero
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 14:00:00.000",
        provider_id: "whoop_ble",
        channel: "power",
        scalar: 200,
        is_deleted: 0,
        version: 0,
      }, // other channel
    ]);
  }, 120_000);

  afterAll(async () => {
    await client.command({
      query: `ALTER TABLE ingest.metric_stream
        DELETE WHERE user_id = {userId:UUID}
        SETTINGS mutations_sync = 1`,
      query_params: { userId: testUserId },
    });
    await client.close?.();
  });

  it("returns per-source minute samples, version-deduped, with non-matching rows excluded", async () => {
    const repo = new HeartRateRepository(reader, testUserId, "UTC");
    const result = await repo.dailyBySource("2026-04-12");

    const byProvider = Object.fromEntries(result.map((series) => [series.providerId, series]));

    expect(Object.keys(byProvider).sort()).toEqual(["apple_health", "whoop_ble"]);

    // apple_health stays separate from whoop_ble at the same minute
    expect(byProvider.apple_health.samples).toEqual([
      { time: "2026-04-12T10:00:00.000Z", heartRate: 70 },
    ]);
    expect(byProvider.apple_health).toEqual(
      expect.objectContaining({
        sampleCount: 1,
        minHeartRate: 70,
        avgHeartRate: 70,
        maxHeartRate: 70,
      }),
    );

    // whoop_ble: 10:00, 10:01, and the version-deduped 11:00 (99, not 50);
    // deleted / other-day / zero / other-channel rows excluded
    expect(byProvider.whoop_ble.samples).toEqual([
      { time: "2026-04-12T10:00:00.000Z", heartRate: 72 },
      { time: "2026-04-12T10:01:00.000Z", heartRate: 74 },
      { time: "2026-04-12T11:00:00.000Z", heartRate: 99 },
    ]);
    expect(byProvider.whoop_ble).toEqual(
      expect.objectContaining({
        sampleCount: 3,
        minHeartRate: 72,
        avgHeartRate: 82,
        maxHeartRate: 99,
      }),
    );
  });

  it("uses the requested timezone when selecting a local calendar day", async () => {
    const beforeLocalMidnightId = randomUUID();
    const atLocalMidnightId = randomUUID();
    await seed([
      {
        id: beforeLocalMidnightId,
        recorded_at: "2026-04-12 06:59:59.000",
        provider_id: "timezone_boundary",
        channel: "heart_rate",
        scalar: 61,
        is_deleted: 0,
        version: 0,
      },
      {
        id: atLocalMidnightId,
        recorded_at: "2026-04-12 07:00:00.000",
        provider_id: "timezone_boundary",
        channel: "heart_rate",
        scalar: 62,
        is_deleted: 0,
        version: 0,
      },
    ]);

    const repo = new HeartRateRepository(reader, testUserId, "America/Los_Angeles");
    const timezoneBoundarySeries = (await repo.dailyBySource("2026-04-12")).find(
      (series) => series.providerId === "timezone_boundary",
    );

    if (!timezoneBoundarySeries) {
      throw new Error("Expected timezone_boundary heart-rate series");
    }

    expect(timezoneBoundarySeries.samples).toEqual([
      { time: "2026-04-12T07:00:00.000Z", heartRate: 62 },
    ]);
  });
});
