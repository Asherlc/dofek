import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { buildAccountErasureFenceTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CyclingFtpSuggestionsRepository } from "./cycling-ftp-suggestions-repository.ts";

describe("CyclingFtpSuggestionsRepository ClickHouse semantics", () => {
  const database = `ftp_suggestions_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const userId = randomUUID();
  const localDayId = randomUUID();
  const userZoneDayId = randomUUID();
  const outOfRangeId = randomUUID();
  const nonCyclingId = randomUUID();
  const zeroOnlyId = randomUUID();
  const zeroOnlyUserId = randomUUID();
  const store: Pick<ActivitySensorStore, "query"> = {
    async query<TSchema extends z.ZodType>(schema: TSchema, query: string, params = {}) {
      const result = await client.query({
        query: query
          .replaceAll("analytics.", `${database}.`)
          .replaceAll("ingest.account_erasure_fence", `${database}.account_erasure_fence`),
        query_params: params,
        format: "JSONEachRow",
      });
      return z.array(schema).parse(await result.json());
    },
  };

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: buildAccountErasureFenceTableSql().replaceAll(
        "ingest.account_erasure_fence",
        `${database}.account_erasure_fence`,
      ),
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_power_curve (
        activity_id UUID, user_id UUID, started_at DateTime64(6, 'UTC'), duration_seconds UInt32,
        best_power Float64, is_deleted UInt8, refresh_version UInt64
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id, duration_seconds)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.deduped_activities (
        activity_id UUID, user_id UUID, started_at DateTime64(6, 'UTC'), local_time_source String,
        start_utc_offset_minutes Nullable(Int16), is_deleted UInt8, refresh_version UInt64
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.activity_summary (
        activity_id UUID, user_id UUID, canonical_type String, name String,
        refresh_version UInt64
      ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    });
    for (const [id, startedAt, type, offset, power] of [
      [localDayId, "2026-06-14 23:30:00", "cycling", 120, 280],
      [userZoneDayId, "2026-06-15 00:30:00", "cycling", -420, 315],
      [outOfRangeId, "2026-06-14 23:30:00", "cycling", -420, 900],
      [nonCyclingId, "2026-06-15 12:00:00", "running", 0, 1000],
    ] as const) {
      await client.command({
        query: `INSERT INTO ${database}.deduped_activities VALUES
          ('${id}', '${userId}', '${startedAt}', 'provider_offset', ${offset}, 0, 1)`,
      });
      await client.command({
        query: `INSERT INTO ${database}.activity_summary VALUES ('${id}', '${userId}', '${type}', '${type}', 1)`,
      });
      await client.command({
        query: `INSERT INTO ${database}.activity_power_curve VALUES
          ('${id}', '${userId}', '${startedAt}', 1200, ${power}, 0, 1),
          ('${id}', '${userId}', '${startedAt}', 600, ${power + 50}, 0, 1)`,
      });
    }
  }, 60_000);

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  it("bounds suggestion evidence by canonical source-local date and excludes other sports", async () => {
    const result = await new CyclingFtpSuggestionsRepository(
      store,
      userId,
      "America/Los_Angeles",
    ).getSuggestions("2026-06-15", "2026-06-15");
    expect(result.methods[1]).toMatchObject({
      method: "95_percent_best_20_minute",
      suggested_ftp: 266,
      evidence: { activity_id: localDayId, date: "2026-06-15", power_watts: 280 },
    });
    expect(result.methods[0]?.evidence?.activity_id).toBe(localDayId);
    expect([userZoneDayId, outOfRangeId, nonCyclingId]).not.toContain(
      result.methods[1]?.evidence?.activity_id,
    );
  });

  it("hides retained suggestion evidence after the user is fenced for erasure", async () => {
    const repository = new CyclingFtpSuggestionsRepository(store, userId, "America/Los_Angeles");
    const beforeFence = await repository.getSuggestions("2026-06-15", "2026-06-15");
    expect(beforeFence.methods[1]).toMatchObject({
      suggested_ftp: 266,
      evidence: { activity_id: localDayId, date: "2026-06-15" },
    });
    await client.command({
      query: `INSERT INTO ${database}.account_erasure_fence (user_hash)
        SELECT lower(hex(SHA256(toString({userId:UUID}))))`,
      query_params: { userId },
    });
    const afterFence = await repository.getSuggestions("2026-06-15", "2026-06-15");
    expect(afterFence.methods).toEqual([
      expect.objectContaining({
        suggested_ftp: null,
        evidence: null,
        unavailable_reason: expect.any(String),
      }),
      expect.objectContaining({
        suggested_ftp: null,
        evidence: null,
        unavailable_reason: expect.any(String),
      }),
    ]);
  });

  it("returns unavailable methods for zero-only observations", async () => {
    await client.command({
      query: `INSERT INTO ${database}.deduped_activities VALUES
        ('${zeroOnlyId}', '${zeroOnlyUserId}', '2026-06-15 12:00:00', 'unknown', NULL, 0, 1)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_summary VALUES ('${zeroOnlyId}', '${zeroOnlyUserId}', 'cycling', 'Zero watts', 1)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_power_curve VALUES
        ('${zeroOnlyId}', '${zeroOnlyUserId}', '2026-06-15 12:00:00', 1200, 0, 0, 1)`,
    });
    const result = await new CyclingFtpSuggestionsRepository(
      store,
      zeroOnlyUserId,
      "UTC",
    ).getSuggestions("2026-06-15", "2026-06-15");
    expect(result.methods[1]).toMatchObject({
      suggested_ftp: null,
      evidence: null,
      unavailable_reason: expect.any(String),
    });
  });
});
