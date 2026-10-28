import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../../../../src/db/clickhouse-activity-summary.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { RunningRepository } from "./running-repository.ts";

describe("running summary query", () => {
  let context: TestContext;
  let repository: RunningRepository;
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "apple_health", "Apple Health", undefined, userId);
    await context.db.insert(activity).values(
      ids.map((id) => ({
        id,
        groupId: id,
        userId,
        providerId: "apple_health",
        externalId: id,
        canonicalType: "running" as const,
        providerType: "running",
        startedAt: new Date("2026-10-01T08:00:00Z"),
        endedAt: new Date("2026-10-01T08:10:00Z"),
      })),
    );
    const client = createClickHouseClientFromEnv();
    const database = `running_query_${randomUUID().replaceAll("-", "")}`;
    const rewrite = (query: string) => query.replaceAll("analytics.", `${database}.`);
    context.addCleanup(async () => {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close?.();
    });
    await client.command({ query: `CREATE DATABASE ${database}` });
    await client.command({ query: rewrite(buildActivitySummaryRowsTableSql()) });
    await client.command({ query: rewrite(buildActivitySummaryViewSql()) });
    await client.insert?.({
      table: `${database}.activity_summary_rows`,
      format: "JSONEachRow",
      values: [
        {
          activity_id: ids[0],
          user_id: userId,
          canonical_type: "running",
          name: null,
          started_at: "2026-10-01 08:00:00",
          ended_at: "2026-10-01 08:10:00",
          avg_cadence: 200,
          cadence_basis: "step_intervals",
          cadence_observed_seconds: 180,
          cadence_coverage_percent: 30,
          avg_ground_contact_time: 210,
          avg_stance_time: 250,
          avg_speed: 3,
          total_distance: 1800,
          refresh_version: 1,
        },
        {
          activity_id: ids[1],
          user_id: userId,
          canonical_type: "running",
          name: "Contact only",
          started_at: "2026-10-01 08:00:00",
          ended_at: "2026-10-01 08:10:00",
          avg_ground_contact_time: 240,
          refresh_version: 1,
        },
        {
          activity_id: ids[2],
          user_id: userId,
          canonical_type: "running",
          name: "Stance only",
          started_at: "2026-10-01 08:00:00",
          ended_at: "2026-10-01 08:10:00",
          avg_stance_time: 260,
          refresh_version: 1,
        },
        {
          activity_id: randomUUID(),
          user_id: randomUUID(),
          canonical_type: "running",
          name: "Foreign",
          started_at: "2026-10-01 08:00:00",
          avg_cadence: 180,
          refresh_version: 1,
        },
      ],
    });
    const store = new ClickHouseActivitySensorStore({
      command: (options) => client.command({ ...options, query: rewrite(options.query) }),
      query: (options) => client.query({ ...options, query: rewrite(options.query) }),
    });
    repository = new RunningRepository(context.db, userId, "UTC", store);
  });
  afterAll(async () => {
    await context?.cleanup();
  });
  it("accepts unnamed runs and prefers ground-contact evidence over legacy stance time", async () => {
    const data = (await repository.getDynamics(null)).map((row) => row.toDetail());
    expect(data.find((row) => row.activityId === ids[0])).toMatchObject({
      activityName: "Run",
      cadence: 200,
      cadenceBasis: "step_intervals",
      cadenceObservedSeconds: 180,
      cadenceCoveragePercent: 30,
      stanceTimeMs: 210,
    });
  });
  it("retains owned form-only runs without manufacturing cadence, pace or distance", async () => {
    const data = (await repository.getDynamics(null)).map((row) => row.toDetail());
    expect(data).toHaveLength(3);
    expect(data.find((row) => row.activityId === ids[1])).toMatchObject({
      cadence: null,
      paceSecondsPerKm: null,
      distanceKm: null,
      stanceTimeMs: 240,
    });
    expect(data.find((row) => row.activityId === ids[2])).toMatchObject({
      cadence: null,
      paceSecondsPerKm: null,
      distanceKm: null,
      stanceTimeMs: 260,
    });
  });
});
