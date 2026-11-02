import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  type CyclingThresholdHistoryInput,
  CyclingThresholdRepository,
} from "./cycling-threshold-repository.ts";

describe("computed cycling threshold serving semantics", () => {
  const database = `cycling_threshold_${randomUUID().replaceAll("-", "")}`;
  const client = createClickHouseClientFromEnv();
  const userId = randomUUID();
  const activityId = randomUUID();
  const store: Pick<ActivitySensorStore, "query"> = {
    async query<T extends z.ZodType>(
      schema: T,
      query: string,
      params: Record<string, unknown> = {},
    ): Promise<z.infer<T>[]> {
      const result = await client.query({
        query: query.replaceAll("analytics.", `${database}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      const rows = await result.json();
      return rows.map((row) => schema.parse(row));
    },
  };
  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({
      query: `CREATE TABLE ${database}.cycling_threshold_history (
      user_id UUID, event_at DateTime64(6, 'UTC'), activity_id Nullable(UUID), eftp Nullable(Float64),
      evidence_activity_id Nullable(UUID), evidence_at Nullable(DateTime64(6, 'UTC')),
      evidence_duration_seconds Nullable(UInt32), evidence_power Nullable(Float64), model_version String
    ) ENGINE = Memory`,
    });
    await client.command({
      query: `INSERT INTO ${database}.cycling_threshold_history VALUES
      ('${userId}', '2026-06-01 06:59:59.999999', '${activityId}', 240, '${activityId}', '2026-05-01 12:00:00', 1200, 260, 'v1'),
      ('${userId}', '2026-06-01 07:00:00.000001', NULL, 239, '${activityId}', '2026-05-01 12:00:00', 1200, 260, 'v1'),
      ('${userId}', '2026-06-02 07:00:00', NULL, 238, '${activityId}', '2026-05-01 12:00:00', 1200, 260, 'v1'),
      ('${userId}', '2026-06-03 07:00:00', NULL, NULL, NULL, NULL, NULL, NULL, 'v1')`,
    });
    await client.command({
      query: `CREATE TABLE ${database}.cycling_activity_power_metrics (
      user_id UUID, activity_id UUID, started_at DateTime64(6, 'UTC'), normalized_power Nullable(Float64),
      eftp Nullable(Float64), power_tss Nullable(Float64), intensity_factor Nullable(Float64),
      evidence_activity_id Nullable(UUID), evidence_at Nullable(DateTime64(6, 'UTC')),
      evidence_duration_seconds Nullable(UInt32), evidence_power Nullable(Float64), model_version String
    ) ENGINE = Memory`,
    });
    await client.command({
      query: `INSERT INTO ${database}.cycling_activity_power_metrics VALUES
      ('${userId}', '${activityId}', '2026-06-01 07:00:00', 240, 245, 80, 0.98, '${activityId}', '2026-05-01 12:00:00', 1200, 260, 'v1')`,
    });
  });
  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database}` });
    await client.close?.();
  });
  it("resolves local calendar end dates and exact timestamp cutoffs", async () => {
    const repository = new CyclingThresholdRepository(store, userId, "America/Los_Angeles");
    expect((await repository.getAsOf("2026-05-31")).value).toBe(240);
    expect((await repository.getAsOf("2026-06-01")).value).toBe(239);
    expect((await repository.getAsOf("2026-06-01T07:00:00.000000Z")).value).toBe(240);
    expect((await repository.getAsOf("2026-06-03T07:00:00Z")).unavailable_reason).toContain(
      "qualifying cycling power evidence",
    );
  });
  it("paginates microsecond boundaries and nullable midnight events without dropping rows", async () => {
    const repository = new CyclingThresholdRepository(store, userId, "UTC");
    const input: CyclingThresholdHistoryInput = {
      startDate: "2026-06-01",
      endDate: "2026-06-02",
      limit: 1,
      cursor: null,
    };
    const values: Array<number | null> = [];
    do {
      const page = await repository.listHistory(input);
      values.push(...page.items.map((item) => item.value));
      input.cursor = page.next_cursor;
    } while (input.cursor);
    expect(values).toEqual([238, 239, 240]);
  });
  it("reads canonical activity metrics and their model provenance with user isolation", async () => {
    const repository = new CyclingThresholdRepository(store, userId, "UTC");
    const metrics = await repository.getForActivities([activityId]);
    expect(metrics.get(activityId)).toMatchObject({
      eftp: 245,
      power_tss: 80,
      model_version: "v1",
      evidence_duration_seconds: 1200,
    });
    expect(
      (
        await new CyclingThresholdRepository(store, randomUUID(), "UTC").getForActivities([
          activityId,
        ])
      ).size,
    ).toBe(0);
  });
});
