import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readModelSql, renderDbtModelSql } from "../../../../src/db/read-model-sql-test-helpers.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { buildLateWorkoutSleepTiming } from "../repositories/late-workout-sleep-timing.ts";
import {
  listPreSleepActivities,
  listWorkoutWindows,
} from "../repositories/pre-sleep-activity-repository.ts";
import { listSleepEpisodes } from "../repositories/sleep-episode-analysis.ts";
import { appRouter } from "../router.ts";
import {
  createClickHouseTestSleepEpisodeStore,
  executeClickHouseTestCommand,
} from "./clickhouse-integration-test-helpers.ts";
import { buildTestAnalyticsTableStatement } from "./clickhouse-integration-test-models.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const groupId = "00000000-0000-4000-8000-000000005711";
const fitId = "00000000-0000-4000-8000-000000005712";
const foreignUser = "00000000-0000-4000-8000-000000005713";
const invalidFitId = "00000000-0000-4000-8000-000000005714";
const input = { days: 1, endDate: "2026-03-10" };
const timingAccess = { startDate: "2026-03-09", endDate: "2026-03-12", timezone: "UTC" };

describe("sleep.lateWorkouts real stores", () => {
  const createCaller = createTestCallerFactory(appRouter);
  let context: TestContext;
  let sensorStore: ActivitySensorStore;

  const clickhouse = (query: string) => executeClickHouseTestCommand(context, query);

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`UPDATE fitness.user_profile SET max_hr = 200 WHERE id = ${TEST_USER_ID}`,
    );
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name, email) VALUES
        (${foreignUser}, 'Other T06 user', 'other-fit@example.test')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name)
      VALUES ('apple_health', 'Apple Health'), ('polar', 'Polar'), ('fit-file', 'FIT file')
      ON CONFLICT DO NOTHING
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.provider_priority (provider_id, priority, sleep_priority)
      VALUES ('apple_health', 1, 1), ('polar', 90, 90)
      ON CONFLICT (provider_id) DO UPDATE SET sleep_priority = excluded.sleep_priority
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.activity_group (id, user_id, anchor_activity_id)
      VALUES (${groupId}, ${TEST_USER_ID}, ${fitId})
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, raw
      ) VALUES (
        ${fitId}, ${groupId}, 'fit-file', ${TEST_USER_ID}, 'late-fit', 'running', 'run',
        '2026-03-09T20:30:00Z', '2026-03-09T21:00:00Z',
        '{"fitPath":"workout.fit","session":{"start_time":"2026-03-09T20:30:00Z","total_elapsed_time":1800}}'
      ), (
        ${invalidFitId}, ${groupId}, 'fit-file', ${TEST_USER_ID}, 'late-fit-no-session', 'running', 'run',
        '2026-03-09T20:30:00Z', '2026-03-09T21:00:00Z',
        '{"fitPath":"no-session.fit","session":null}'
      ), (
        DEFAULT, DEFAULT, 'fit-file', ${TEST_USER_ID}, 'before-access', 'cycling', 'ride',
        '2026-03-08T20:00:00Z', '2026-03-09T07:15:00Z', null
      ), (
        DEFAULT, DEFAULT, 'fit-file', ${foreignUser}, 'foreign-workout', 'cycling', 'ride',
        '2026-03-09T21:00:00Z', '2026-03-09T22:00:00Z', null
      )
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.sleep_session (
        provider_id, user_id, external_id, started_at, ended_at, duration_minutes, sleep_type
      ) VALUES
        ('polar', ${TEST_USER_ID}, 'before-access', '2026-03-06T00:30:00Z', '2026-03-06T07:00:00Z', 390, 'sleep'),
        ('apple_health', ${TEST_USER_ID}, 'preceding', '2026-03-08T23:00:00Z', '2026-03-09T07:00:00Z', 480, 'sleep'),
        ('apple_health', ${TEST_USER_ID}, 'in-bed', '2026-03-09T22:30:00Z', '2026-03-10T07:00:00Z', 510, 'sleep'),
        ('polar', ${TEST_USER_ID}, 'detected', '2026-03-09T23:00:00Z', '2026-03-10T07:00:00Z', 460, 'sleep'),
        ('apple_health', ${TEST_USER_ID}, 'in-bed-only', '2026-03-10T23:00:00Z', '2026-03-11T07:00:00Z', 480, 'sleep'),
        ('polar', ${TEST_USER_ID}, 'reference', '2026-03-11T23:00:00Z', '2026-03-12T07:00:00Z', 460, 'sleep'),
        ('polar', ${foreignUser}, 'foreign', '2026-03-09T23:15:00Z', '2026-03-10T07:15:00Z', 333, 'sleep')
    `);
    sensorStore = await createClickHouseTestSleepEpisodeStore(context);
    for (const table of ["analytics.deduped_activities", "analytics.activity_sensor_sample"]) {
      await clickhouse(buildTestAnalyticsTableStatement(table));
    }
    await clickhouse(`CREATE TABLE IF NOT EXISTS analytics.activity_fit_heart_rate (
      user_id UUID, activity_id UUID, member_activity_id Nullable(UUID),
      started_at Nullable(DateTime64(6, 'UTC')), ended_at Nullable(DateTime64(6, 'UTC')),
      status String, covered_seconds UInt64, bpm_seconds Array(Tuple(Float64, UInt64)),
      is_deleted UInt8, source_sensor_version UInt64, refresh_version UInt64,
      source_activity_version UInt64, source_member_version UInt64
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`);
    await clickhouse(`CREATE TABLE IF NOT EXISTS analytics.activity_source_records (
      user_id UUID, activity_id UUID, provider_id String, source_synced_at Nullable(DateTime64(9, 'UTC')),
      raw Nullable(String),
      started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
      refresh_version UInt64, is_deleted UInt8
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`);
    await clickhouse(`INSERT INTO analytics.deduped_activities
      (user_id, activity_id, member_activity_ids, refresh_version, is_deleted)
      VALUES ('${TEST_USER_ID}', '${groupId}', ['${fitId}', '${invalidFitId}'], 20, 0)`);
    await clickhouse(`INSERT INTO analytics.activity_source_records
      (user_id, activity_id, provider_id, source_synced_at, raw, started_at, ended_at, refresh_version, is_deleted)
      VALUES
        ('${TEST_USER_ID}', '${fitId}', 'fit-file', '2026-03-09 21:00:01',
          '{"fitPath":"workout.fit","session":{"start_time":"2026-03-09T20:30:00Z","total_elapsed_time":1800}}',
          '2026-03-09 20:30:00', '2026-03-09 21:00:00', 21, 0),
        ('${TEST_USER_ID}', '${invalidFitId}', 'fit-file', '2026-03-10 21:00:01',
          '{"fitPath":"no-session.fit","session":null}', '2026-03-09 20:30:00', '2026-03-09 21:00:00', 22, 0)`);
    await clickhouse(`CREATE TABLE IF NOT EXISTS analytics.deduped_activity_members (
      user_id UUID, activity_id UUID, member_activity_id UUID, refresh_version UInt64, is_deleted UInt8
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, member_activity_id)`);
    await clickhouse(`INSERT INTO analytics.deduped_activity_members
      (user_id, activity_id, member_activity_id, refresh_version, is_deleted)
      VALUES
        ('${TEST_USER_ID}', '${groupId}', '${fitId}', 22, 0),
        ('${TEST_USER_ID}', '${groupId}', '${invalidFitId}', 22, 0)`);
    await clickhouse(`INSERT INTO analytics.activity_sensor_sample
      (user_id, activity_id, recorded_at, recorded_date, channel, scalar, provider_id,
       member_activity_id, source_type, measurement_kind, refresh_version, is_deleted)
      SELECT toUUID('${TEST_USER_ID}'), toUUID('${groupId}'),
        addSeconds(toDateTime64('2026-03-09 20:30:00', 6, 'UTC'), number),
        toDate('2026-03-09'), 'heart_rate', 130, 'fit-file', toUUID('${fitId}'), 'file', 'unknown', 10, 0
      FROM numbers(1800)`);
    const model = renderDbtModelSql(readModelSql("activity_fit_heart_rate.sql"), {
      isIncremental: true,
    })
      .replaceAll(/\{\{ ref\('([a-z_]+)'\) \}\}/g, "analytics.$1")
      .replaceAll("{{ this }}", "analytics.activity_fit_heart_rate");
    await clickhouse(`INSERT INTO analytics.activity_fit_heart_rate ${model}
      SETTINGS max_threads = 1, join_use_nulls = 1, enable_materialized_cte = 1`);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  function caller(userId: string, accessWindow?: AccessWindow) {
    return createCaller({
      db: context.db,
      sensorStore,
      userId,
      timezone: "UTC",
      accessWindow,
      cacheMode: "refresh",
    });
  }

  it("serves owned FIT timing and load, then withholds a stale sample revision", async () => {
    const owner = caller(TEST_USER_ID);
    await expect(owner.sleep.lateWorkouts(input)).resolves.toMatchObject({
      matchedNightCount: 1,
      measuredLoadNightCount: 1,
      nights: [
        {
          sleepProvider: "polar",
          durationMinutes: 460,
          status: "matched",
          workouts: [
            { canonicalType: "cycling", status: "crosses_wake_window" },
            { id: groupId, fitMemberId: fitId },
          ],
          habitualOnset: {
            referenceNights: [
              { date: "2026-03-06" },
              { date: "2026-03-10" },
              { date: "2026-03-12" },
            ],
          },
          load: { score: 60, category: "light", coveredSeconds: 1800 },
        },
      ],
    });
    await expect(caller(foreignUser).sleep.lateWorkouts(input)).resolves.toMatchObject({
      matchedNightCount: 0,
      measuredLoadNightCount: 0,
      nights: [{ durationMinutes: 333, workouts: [] }],
    });
    await expect(
      caller(TEST_USER_ID, {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-03-10",
        endDateExclusive: "2026-03-11",
      }).sleep.lateWorkouts(input),
    ).resolves.toMatchObject({
      matchedNightCount: 0,
      nights: [
        {
          previousWake: null,
          workouts: [],
          habitualOnset: {
            referenceNights: [{ date: "2026-03-10" }],
          },
        },
      ],
    });

    await clickhouse(`INSERT INTO analytics.activity_sensor_sample
      SELECT * REPLACE (toUInt64(11) AS refresh_version, toUInt8(1) AS is_deleted)
      FROM analytics.activity_sensor_sample FINAL
      WHERE user_id = toUUID('${TEST_USER_ID}') AND activity_id = toUUID('${groupId}')
        AND recorded_at = toDateTime64('2026-03-09 20:30:00', 6, 'UTC')`);
    await expect(owner.sleep.lateWorkouts(input)).resolves.toMatchObject({
      matchedNightCount: 1,
      measuredLoadNightCount: 0,
      nights: [{ status: "matched", load: { score: null, reason: expect.any(String) } }],
    });
  });

  it("selects Polar within the overlap and preserves the ordinary Apple Health read and summary", async () => {
    const input = { ...timingAccess, userId: TEST_USER_ID, profileTimezone: timingAccess.timezone };
    const ordinary = await listSleepEpisodes(sensorStore, input);
    const selected = await listSleepEpisodes(sensorStore, {
      ...input,
      detectedOnsetAccess: timingAccess,
    });
    const ordinarySession = ordinary.find(({ date }) => date === "2026-03-10");
    const selectedSession = selected.find(({ date }) => date === "2026-03-10");

    expect(ordinarySession?.timing.source_provider).toBe("apple_health");
    expect(selectedSession).toMatchObject({
      timing: { source_provider: "polar", started_at: "2026-03-09T23:00:00Z" },
      duration_minutes: 460,
    });
    expect(selectedSession?.timing.source_session_ids).toEqual(
      ordinarySession?.timing.source_session_ids,
    );
    expect(selectedSession?.timing.source_session_ids).toHaveLength(2);

    const summary = await listPreSleepActivities(context.db, TEST_USER_ID, ordinary, "UTC", {
      providers: [],
      modalities: [],
      canonicalTypes: [],
    });
    expect(
      ordinarySession && summary.get(ordinarySession.timing.selected_session_id),
    ).toMatchObject({
      activity_count: 2,
      duration: { value_minutes: 45, supported_activities: 2 },
      last_activity: { id: groupId },
      minutes_to_sleep: 90,
    });
  });

  it("limits timing evidence to the permitted account and dates while keeping Apple Health-only context", async () => {
    const episodes = await listSleepEpisodes(sensorStore, {
      ...timingAccess,
      startDate: "2026-03-06",
      userId: TEST_USER_ID,
      profileTimezone: timingAccess.timezone,
      detectedOnsetAccess: timingAccess,
    });
    const windows = await listWorkoutWindows(context.db, TEST_USER_ID, episodes, timingAccess);
    const results = buildLateWorkoutSleepTiming(episodes, windows, timingAccess);

    expect(episodes.map(({ date }) => date)).toEqual([
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
    ]);
    expect(results).toMatchObject([
      { date: "2026-03-09", workouts: [], actualOnset: null },
      {
        date: "2026-03-10",
        status: "matched",
        habitualOnset: { referenceNights: [{ date: "2026-03-10" }, { date: "2026-03-12" }] },
        workouts: [{ id: groupId, canonicalType: "running", fitMemberId: fitId }],
        minutesFromFinishToSleep: 120,
      },
      { date: "2026-03-11", actualOnset: null, durationMinutes: null, status: "onset_unavailable" },
      { date: "2026-03-12", workouts: [], actualOnset: "2026-03-11T23:00:00Z" },
    ]);
    expect(results[1]?.workouts).toHaveLength(1);
  });
});
