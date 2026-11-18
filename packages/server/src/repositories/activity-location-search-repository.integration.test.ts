import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { activityLocationRouter } from "../routers/activity-location.ts";
import {
  createClickHouseTestActivitySensorReaderStore,
  getClickHouseTestClient,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { ActivityLocationSearchRepository } from "./activity-location-search-repository.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const namedClimb = "10000000-0000-4000-8000-000000000001";
const oldClimb = "10000000-0000-4000-8000-000000000002";
const absentClimb = "10000000-0000-4000-8000-000000000003";
const nearbyRun = "10000000-0000-4000-8000-000000000004";
const nearbyRide = "10000000-0000-4000-8000-000000000005";
const distantRun = "10000000-0000-4000-8000-000000000006";
const otherUsersRun = "10000000-0000-4000-8000-000000000007";
const otherUser = "10000000-0000-4000-8000-000000000008";
const parentArea = "10000000-0000-4000-8000-000000000009";
const gym = "10000000-0000-4000-8000-000000000010";
const startedAt = "2026-03-15T10:00:00Z";
const endedAt = "2026-03-15T11:00:00Z";
const nearby = { kind: "nearby", latitude: 37.8045, longitude: -122.2714 } as const;

describe("activity location matching", () => {
  let context: TestContext;
  let repository: ActivityLocationSearchRepository;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    vi.stubEnv("CREDENTIAL_ENCRYPTION_KEY_BASE64", Buffer.alloc(32, 1).toString("base64"));
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${otherUser}, 'Other User')`,
    );
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id) VALUES
      ('location-fixture', 'Location fixture', ${TEST_USER_ID}),
      ('other-location-fixture', 'Other location fixture', ${otherUser})`);
    await context.db.execute(sql`INSERT INTO fitness.activity (
      id, group_id, user_id, provider_id, external_id, canonical_type, provider_type, name,
      started_at, ended_at, provider_absent_at
    ) VALUES
      (${namedClimb}, ${namedClimb}, ${TEST_USER_ID}, 'location-fixture', 'climb', 'climbing', 'climbing_log', 'Climb', ${startedAt}, ${endedAt}, NULL),
      (${oldClimb}, ${oldClimb}, ${TEST_USER_ID}, 'location-fixture', 'old', 'climbing', 'climbing_log', 'Old Climb', '2026-03-05T10:00:00Z', '2026-03-05T11:00:00Z', NULL),
      (${absentClimb}, ${absentClimb}, ${TEST_USER_ID}, 'location-fixture', 'absent', 'climbing', 'climbing_log', 'Missing Climb', ${startedAt}, ${endedAt}, ${endedAt}),
      (${nearbyRun}, ${nearbyRun}, ${TEST_USER_ID}, 'location-fixture', 'run', 'running', 'running', 'Morning Run', ${startedAt}, ${endedAt}, NULL),
      (${nearbyRide}, ${nearbyRide}, ${TEST_USER_ID}, 'location-fixture', 'ride', 'cycling', 'cycling', 'Morning Ride', ${startedAt}, ${endedAt}, NULL),
      (${distantRun}, ${distantRun}, ${TEST_USER_ID}, 'location-fixture', 'far', 'running', 'running', 'Morning Run', ${startedAt}, ${endedAt}, NULL),
      (${otherUsersRun}, ${otherUsersRun}, ${otherUser}, 'other-location-fixture', 'other', 'running', 'running', 'Morning Run', ${startedAt}, ${endedAt}, NULL)`);
    await context.db.execute(sql`INSERT INTO fitness.area (id, user_id, provider_id, name, parent_area_id) VALUES
      (${parentArea}, ${TEST_USER_ID}, 'location-fixture', 'East Bay', NULL),
      (${gym}, ${TEST_USER_ID}, 'location-fixture', 'Boulders_100%', ${parentArea})`);
    await context.db.execute(sql`INSERT INTO fitness.climbing_log_entry (user_id, provider_id, activity_id, area_id, discipline) VALUES
      (${TEST_USER_ID}, 'location-fixture', ${namedClimb}, ${gym}, 'rock_climbing'),
      (${TEST_USER_ID}, 'location-fixture', ${oldClimb}, ${gym}, 'rock_climbing'),
      (${TEST_USER_ID}, 'location-fixture', ${absentClimb}, ${gym}, 'rock_climbing')`);
    sensorStore = await createClickHouseTestActivitySensorReaderStore(context);
    const clickhouse = getClickHouseTestClient(context);
    const fixtures = [
      { id: namedClimb, type: "climbing", name: "Climb" },
      { id: nearbyRun, type: "running", name: "Morning Run", latitude: 37.8, longitude: -122.27 },
      { id: nearbyRide, type: "cycling", name: "Morning Ride", latitude: 37.8, longitude: -122.27 },
      { id: distantRun, type: "running", name: "Morning Run", latitude: 34.05, longitude: -118.24 },
      {
        id: otherUsersRun,
        type: "running",
        name: "Morning Run",
        latitude: 37.8,
        longitude: -122.27,
      },
    ].map((fixture) => ({
      ...fixture,
      userId: fixture.id === otherUsersRun ? otherUser : TEST_USER_ID,
      providerId: fixture.id === otherUsersRun ? "other-location-fixture" : "location-fixture",
    }));
    await clickhouse.insert({
      table: "analytics.deduped_activities",
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
      values: fixtures.map(({ id, userId, name, providerId, type }) => ({
        activity_id: id,
        user_id: userId,
        name,
        canonical_type: type,
        provider_type: type === "climbing" ? "climbing_log" : type,
        provider_id: providerId,
        started_at: startedAt,
        ended_at: endedAt,
        local_time_source: "unknown",
        representative_activity_id: id,
        origin_candidate_member_ids: [id],
        member_activity_ids: [id],
      })),
    });
    await clickhouse.insert({
      table: "analytics.activity_summary_rows",
      format: "JSONEachRow",
      clickhouse_settings: { date_time_input_format: "best_effort" },
      values: fixtures.map(({ id, userId, latitude, longitude, type }) => ({
        activity_id: id,
        user_id: userId,
        canonical_type: type,
        provider_type: type,
        started_at: startedAt,
        ended_at: endedAt,
        centroid_lat: latitude ?? null,
        centroid_lng: longitude ?? null,
      })),
    });
    repository = new ActivityLocationSearchRepository(
      context.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-03-10",
        endDateExclusive: "2026-03-17",
      },
    );
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
    vi.unstubAllEnvs();
  });

  it.each(["eAsT BaY", "Boulders_100%"])(
    "finds the visible climb at %s without GPS",
    async (name) => {
      const results = await repository.findCandidates({
        location: { kind: "name", name },
        limit: 5,
      });
      expect(results.map(({ id }) => id)).toEqual([namedClimb]);
    },
  );

  it("uses literal names and applies the sport filter", async () => {
    await expect(
      repository.findCandidates({ location: { kind: "name", name: "%_" }, limit: 5 }),
    ).resolves.toEqual([]);
    await expect(
      repository.findCandidates({
        location: { kind: "name", name: "East Bay" },
        activityType: "running",
        limit: 5,
      }),
    ).resolves.toEqual([]);
  });

  it("paginates nearby activities at equal timestamps within the account", async () => {
    const [first] = await repository.findCandidates({ location: nearby, limit: 1 });
    expect(first?.id).toBe(nearbyRide);
    const second = await repository.findCandidates({ location: nearby, limit: 2, after: first });
    expect(second.map(({ id }) => id)).toEqual([nearbyRun]);
    const running = await repository.findCandidates({
      location: nearby,
      activityType: "running",
      limit: 5,
    });
    expect(running.map(({ id }) => id)).toEqual([nearbyRun]);
  });

  function caller() {
    return activityLocationRouter.createCaller({
      accountErasureRestoreLedger: {
        findIntent: async () => null,
        listIntentReferences: async () => [],
        listIntentsForIdentities: async () => [],
        recordIntent: async () => undefined,
      },
      db: context.db,
      sensorStore,
      userId: TEST_USER_ID,
      timezone: "UTC",
    });
  }

  it("returns activity cards with a cursor that resumes after the returned card", async () => {
    const first = await caller().search({ location: nearby, pageSize: 1 });
    expect(first.activities.map(({ id, name }) => [id, name])).toEqual([
      [nearbyRide, "Morning Ride"],
    ]);
    expect(first.next).not.toBeNull();
    const second = await caller().search({ location: nearby, pageSize: 1, cursor: first.next });
    expect(second.activities.map(({ id }) => id)).toEqual([nearbyRun]);
    expect(second.next).toBeNull();
  });

  it("fills the page past a stale hidden activity and keeps the cursor opaque", async () => {
    const clickhouse = getClickHouseTestClient(context);
    await clickhouse.command({
      query: `
        INSERT INTO analytics.deduped_activities
          (activity_id, user_id, canonical_type, provider_type, started_at, ended_at, local_time_source)
        VALUES ('${absentClimb}', '${TEST_USER_ID}', 'climbing', 'climbing_log',
          '2026-03-16 10:00:00', '2026-03-16 11:00:00', 'unknown')
      `,
    });
    await clickhouse.command({
      query: `
        INSERT INTO analytics.activity_summary_rows
          (activity_id, user_id, canonical_type, provider_type, started_at, ended_at, centroid_lat, centroid_lng)
        VALUES ('${absentClimb}', '${TEST_USER_ID}', 'climbing', 'climbing_log',
          '2026-03-16 10:00:00', '2026-03-16 11:00:00', 37.8, -122.27)
      `,
    });
    const { next, activities } = await caller().search({ location: nearby, pageSize: 1 });
    expect(activities.map(({ id }) => id)).toEqual([nearbyRide]);
    expect(next).toEqual(expect.any(String));
    expect(next).not.toContain(absentClimb);
    await expect(
      caller().search({ location: { ...nearby, latitude: 38 }, cursor: next }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const second = await caller().search({ location: nearby, pageSize: 1, cursor: next });
    expect(second.activities.map(({ id }) => id)).toEqual([nearbyRun]);
    expect(second.next).toBeNull();
  });
});
