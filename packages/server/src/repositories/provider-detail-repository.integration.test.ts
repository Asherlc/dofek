import { randomUUID } from "node:crypto";
import type { Database } from "dofek/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { buildClickHouseBootstrapStatementsForNativeMetricStream } from "../../../../src/db/clickhouse-metric-stream-bootstrap.ts";
import type { BodyClickHouseStore } from "./body-clickhouse.ts";
import { ProviderDetailRepository } from "./provider-detail-repository.ts";

// metricStream reads only touch ClickHouse; the repository still requires a
// Postgres Database to construct, but it is never queried by these tests.
const noopDb: Pick<Database, "execute" | "transaction"> = {
  execute: vi.fn(async () => []),
  transaction: vi.fn(),
};

const testUserId = "00000000-0000-0000-0000-0000000000b2";

interface SeedRow {
  id: string;
  recorded_at: string;
  provider_id: string;
  channel: string;
  scalar: number;
  is_deleted: 0 | 1;
  version: number;
}

const client = createClickHouseClientFromEnv();

// The repository only needs a ClickHouse query runner (BodyClickHouseStore shape).
const clickHouse: BodyClickHouseStore = {
  async query(schema, query, params) {
    if (!client.query) throw new Error("ClickHouse client must support query");
    const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
    const rows = await result.json();
    return rows.map((row) => schema.parse(row));
  },
};

async function seed(rows: SeedRow[]): Promise<void> {
  await client.insert?.({
    table: "ingest.metric_stream",
    format: "JSONEachRow",
    values: rows.map((row) => ({
      id: row.id,
      user_id: testUserId,
      recorded_at: row.recorded_at,
      provider_id: row.provider_id,
      channel: row.channel,
      scalar: row.scalar,
      is_deleted: row.is_deleted,
      ingested_at: "2026-04-12 00:00:00.000",
      version: row.version,
    })),
  });
}

const rowSchema = z.object({
  id: z.string(),
  recorded_at: z.string(),
  provider_id: z.string(),
  channel: z.string(),
  scalar: z.number().nullable(),
});

describe("ProviderDetailRepository metric stream (integration)", () => {
  const supersededId = "11111111-1111-4111-8111-111111111111";

  beforeAll(async () => {
    for (const statement of buildClickHouseBootstrapStatementsForNativeMetricStream("")) {
      await client.command({ query: statement });
    }
    await client.command({
      query: "DELETE FROM ingest.metric_stream WHERE user_id = {userId:UUID}",
      query_params: { userId: testUserId },
    });
    await seed([
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:00:00.000",
        provider_id: "withings",
        channel: "heart_rate",
        scalar: 60,
        is_deleted: 0,
        version: 0,
      },
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:05:00.000",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 80,
        is_deleted: 0,
        version: 0,
      },
      // version dedup: v1 (90) supersedes v0 (50)
      {
        id: supersededId,
        recorded_at: "2026-04-12 10:10:00.000",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 50,
        is_deleted: 0,
        version: 0,
      },
      {
        id: supersededId,
        recorded_at: "2026-04-12 10:10:00.000",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 90,
        is_deleted: 0,
        version: 1,
      },
      // excluded: deleted + other provider
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:15:00.000",
        provider_id: "withings",
        channel: "heart_rate",
        scalar: 70,
        is_deleted: 1,
        version: 1,
      },
      {
        id: randomUUID(),
        recorded_at: "2026-04-12 10:20:00.000",
        provider_id: "fitbit",
        channel: "heart_rate",
        scalar: 65,
        is_deleted: 0,
        version: 0,
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await client.command({
      query: "DELETE FROM ingest.metric_stream WHERE user_id = {userId:UUID}",
      query_params: { userId: testUserId },
    });
    await client.close?.();
  });

  it("returns a provider's metric-stream rows, version-deduped, newest first", async () => {
    const repo = new ProviderDetailRepository(noopDb, testUserId, clickHouse);

    const rows = (await repo.getRecords("withings", "metricStream", 50, 0)).map((row) =>
      rowSchema.parse(row),
    );

    // withings only, deleted excluded, superseded version dedup -> 90 (not 50), newest first
    expect(rows).toEqual([
      {
        id: supersededId,
        recorded_at: "2026-04-12T10:10:00.000000Z",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 90,
      },
      {
        id: expect.any(String),
        recorded_at: "2026-04-12T10:05:00.000000Z",
        provider_id: "withings",
        channel: "body_weight",
        scalar: 80,
      },
      {
        id: expect.any(String),
        recorded_at: "2026-04-12T10:00:00.000000Z",
        provider_id: "withings",
        channel: "heart_rate",
        scalar: 60,
      },
    ]);
    expect(rows.some((row) => row.provider_id === "fitbit")).toBe(false);
  });

  it("returns a single record by id", async () => {
    const repo = new ProviderDetailRepository(noopDb, testUserId, clickHouse);
    const detail = await repo.getRecordDetail("withings", "metricStream", supersededId);
    expect(detail).toMatchObject({ id: supersededId, scalar: 90, channel: "body_weight" });
  });
});
