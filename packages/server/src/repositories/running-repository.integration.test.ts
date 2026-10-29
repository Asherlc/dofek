import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../../../../src/db/clickhouse-activity-summary.ts";
import { createMigration } from "../../../../src/db/clickhouse-migrations/0107_running_step_cadence.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { TEST_USER_ID as userId } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { RunningRepository } from "./running-repository.ts";

describe("running summary query", () => {
  let context: TestContext;
  let repository: RunningRepository;
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
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
      try {
        await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      } finally {
        await client.close?.();
      }
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
          ended_at: "2026-10-01 08:40:00",
          avg_cadence: 200,
          cadence_basis: "step_intervals",
          cadence_observed_seconds: 180,
          cadence_coverage_percent: 30,
          avg_ground_contact_time: 210,
          avg_stance_time: 250,
          avg_speed: 3.5,
          total_distance: 8500,
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
          activity_id: ids[3],
          user_id: userId,
          canonical_type: "running",
          name: "Tempo Run",
          started_at: "2026-10-02 08:00:00",
          ended_at: "2026-10-02 08:41:40",
          avg_cadence: 180,
          avg_speed: 4,
          total_distance: 10000,
          avg_stride_length: 1.2,
          avg_stance_time: 230,
          avg_vertical_osc: 85,
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
  it("retains pace metrics for unnamed runs alongside named runs", async () => {
    expect((await repository.getPaceTrend(null)).map((row) => row.toDetail())).toEqual([
      {
        date: "2026-10-01",
        activityName: "Running",
        paceSecondsPerKm: 286,
        distanceKm: 8.5,
        durationMinutes: 40,
      },
      {
        date: "2026-10-02",
        activityName: "Tempo Run",
        paceSecondsPerKm: 250,
        distanceKm: 10,
        durationMinutes: 42,
      },
    ]);
  });
  it("retains named running dynamics alongside unnamed and form-only runs", async () => {
    const data = (await repository.getDynamics(null)).map((row) => row.toDetail());
    expect(data.find((row) => row.activityId === ids[3])).toEqual({
      activityId: ids[3],
      date: "2026-10-02",
      activityName: "Tempo Run",
      cadence: 180,
      cadenceBasis: "unknown",
      cadenceObservedSeconds: null,
      cadenceCoveragePercent: null,
      strideLengthMeters: 1.2,
      stanceTimeMs: 230,
      verticalOscillationMm: 85,
      paceSecondsPerKm: 250,
      distanceKm: 10,
    });
  });
  it("accepts unnamed runs and prefers ground-contact evidence over legacy stance time", async () => {
    const data = (await repository.getDynamics(null)).map((row) => row.toDetail());
    expect(data.find((row) => row.activityId === ids[0])).toMatchObject({
      activityName: "Running",
      cadence: 200,
      cadenceBasis: "step_intervals",
      cadenceObservedSeconds: 180,
      cadenceCoveragePercent: 30,
      stanceTimeMs: 210,
    });
  });
  it("retains owned form-only runs without manufacturing cadence, pace or distance", async () => {
    const data = (await repository.getDynamics(null)).map((row) => row.toDetail());
    expect(data).toHaveLength(4);
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

describe("running summary legacy-view upgrade", () => {
  let context: TestContext;
  afterAll(async () => {
    await context?.cleanup();
  });

  it("upgrades the pre-0107 projection and preserves cadence through a repeated migration", async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "apple_health", "Apple Health", undefined, userId);
    const legacyId = randomUUID();
    const refreshedId = randomUUID();
    const deletedId = randomUUID();
    await context.db.insert(activity).values(
      [legacyId, refreshedId, deletedId].map((id) => ({
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
    const database = `running_upgrade_${randomUUID().replaceAll("-", "")}`;
    const rewrite = (query: string) => query.replaceAll("analytics.", `${database}.`);
    context.addCleanup(async () => {
      try {
        await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      } finally {
        await client.close?.();
      }
    });
    const mappedClient = {
      command: (options: Parameters<typeof client.command>[0]) =>
        client.command({ ...options, query: rewrite(options.query) }),
      query: (options: Parameters<typeof client.query>[0]) =>
        client.query({ ...options, query: rewrite(options.query) }),
    };
    await client.command({ query: `CREATE DATABASE ${database} ENGINE = Atomic` });
    await mappedClient.command({ query: buildActivitySummaryRowsTableSql() });
    await mappedClient.command({ query: buildActivitySummaryViewSql() });
    await mappedClient.command({ query: "DROP VIEW IF EXISTS analytics.activity_summary" });
    await mappedClient.command({
      query: `ALTER TABLE analytics.activity_summary_rows
        DROP COLUMN cadence_coverage_percent,
        DROP COLUMN cadence_observed_seconds,
        DROP COLUMN cadence_basis`,
    });
    // Frozen pre-0107 projection: independent of the current view builder.
    await mappedClient.command({
      query: `CREATE VIEW analytics.activity_summary AS
        SELECT activity_id, user_id,
          assumeNotNull(canonical_type) AS canonical_type,
          provider_type, modality, name,
          assumeNotNull(started_at) AS started_at, ended_at,
          avg_hr, max_hr, min_hr, avg_power, max_power, avg_speed, max_speed, avg_cadence,
          elevation_gain_legacy, total_distance, centroid_lat, centroid_lng,
          avg_left_balance, avg_left_torque_eff, avg_right_torque_eff,
          avg_left_pedal_smooth, avg_right_pedal_smooth,
          elevation_gain_m, elevation_loss_m, avg_stance_time, avg_vertical_osc,
          avg_ground_contact_time, avg_stride_length, sample_count,
          hr_sample_count, power_sample_count, first_sample_at, last_sample_at,
          best_twenty_minute_power, normalized_power, smoothed_avg_power,
          climbing_elevation_gain_m, climbing_seconds, refreshed_at
        FROM analytics.activity_summary_rows FINAL
        WHERE is_deleted = 0`,
    });
    const legacyRow = {
      activity_id: legacyId,
      user_id: userId,
      canonical_type: "running",
      name: "Legacy cadence",
      started_at: "2026-10-01 08:00:00",
      ended_at: "2026-10-01 08:10:00",
      avg_cadence: 172,
      refresh_version: 2,
    };
    await client.insert?.({
      table: `${database}.activity_summary_rows`,
      format: "JSONEachRow",
      values: [
        { ...legacyRow, avg_cadence: 100, refresh_version: 1 },
        legacyRow,
        { ...legacyRow, activity_id: deletedId, refresh_version: 1 },
        { ...legacyRow, activity_id: deletedId, is_deleted: 1 },
      ],
    });
    const migration = createMigration();
    if (!migration.run) throw new Error("0107 must execute its full migration body");
    await migration.run(mappedClient, context.connectionString);
    const repository = new RunningRepository(
      context.db,
      userId,
      "UTC",
      new ClickHouseActivitySensorStore(mappedClient),
    );
    const legacyExpected = {
      activityId: legacyId,
      cadence: 172,
      cadenceBasis: "unknown",
      cadenceObservedSeconds: null,
      cadenceCoveragePercent: null,
    };
    const upgraded = (await repository.getDynamics(null)).map((row) => row.toDetail());
    expect(upgraded).toHaveLength(1);
    expect(upgraded[0]).toMatchObject(legacyExpected);

    await client.insert?.({
      table: `${database}.activity_summary_rows`,
      format: "JSONEachRow",
      values: [
        {
          ...legacyRow,
          activity_id: refreshedId,
          name: "Step cadence",
          avg_cadence: 188,
          cadence_basis: "step_intervals",
          cadence_observed_seconds: 432,
          cadence_coverage_percent: 72,
        },
      ],
    });
    const refreshedExpected = {
      activityId: refreshedId,
      cadence: 188,
      cadenceBasis: "step_intervals",
      cadenceObservedSeconds: 432,
      cadenceCoveragePercent: 72,
    };
    const refreshed = (await repository.getDynamics(null)).map((row) => row.toDetail());
    expect(refreshed).toHaveLength(2);
    expect(refreshed.find((row) => row.activityId === legacyId)).toMatchObject(legacyExpected);
    expect(refreshed.find((row) => row.activityId === refreshedId)).toMatchObject(
      refreshedExpected,
    );

    await migration.run(mappedClient, context.connectionString);
    const repeated = (await repository.getDynamics(null)).map((row) => row.toDetail());
    expect(repeated).toHaveLength(2);
    expect(repeated.find((row) => row.activityId === legacyId)).toMatchObject(legacyExpected);
    expect(repeated.find((row) => row.activityId === refreshedId)).toMatchObject(refreshedExpected);
  });
});
