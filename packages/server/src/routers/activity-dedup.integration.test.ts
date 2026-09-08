import { queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { reconcileActivityGroups } from "../../../../src/db/activity-group-reconciliation.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

describe("Persisted PostgreSQL activity representatives", () => {
  let context: TestContext;
  const groupId = "00000000-0000-4000-8000-000000000301";
  const firstId = "00000000-0000-4000-8000-000000000302";
  const secondId = "00000000-0000-4000-8000-000000000303";
  const exerciseId = "00000000-0000-4000-8000-000000000304";
  const projectionSchema = z.object({
    id: z.string(),
    primary_activity_id: z.string(),
    member_activity_ids: z.array(z.string()),
    source_providers: z.array(z.string()),
    source_external_ids: z.array(z.object({ memberActivityId: z.string() }).passthrough()),
    started_at: z.string(),
    ended_at: z.string(),
    raw: z.record(z.string(), z.unknown()),
    timezone: z.string().nullable(),
    local_time_source: z.string(),
    perceived_exertion: z.number().nullable(),
  });
  const readProjection = () =>
    executeWithSchema(
      context.db,
      projectionSchema,
      sql`SELECT id, primary_activity_id, member_activity_ids::text[], source_providers,
        source_external_ids, started_at::text, ended_at::text, raw, timezone,
        local_time_source, perceived_exertion
        FROM fitness.v_activity WHERE ${firstId}::uuid = ANY(member_activity_ids)`,
    );

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('wahoo', 'Wahoo', ${TEST_USER_ID}), ('apple_health', 'Apple Health', ${TEST_USER_ID})
      ON CONFLICT DO NOTHING`);
    await context.db.execute(
      sql`INSERT INTO fitness.exercise (id, name) VALUES (${exerciseId}::uuid, 'Squat')`,
    );
  });
  afterAll(async () => {
    await context?.cleanup();
  });
  beforeEach(async () => {
    await context.db.execute(sql`DELETE FROM fitness.activity`);
    await context.db.execute(sql`INSERT INTO fitness.provider_priority (provider_id, priority)
      VALUES ('wahoo', 1), ('apple_health', 99)
      ON CONFLICT (provider_id) DO UPDATE SET priority = EXCLUDED.priority`);
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type,
       started_at, ended_at, raw, timezone, local_time_source, perceived_exertion)
      VALUES
      (${firstId}::uuid, ${groupId}::uuid, ${TEST_USER_ID}, 'wahoo', 'representative-first',
       'strength', 'strength', '2026-01-01 10:00:00+00', '2026-01-01 11:00:00+00',
       '{"first":1}', NULL, 'unknown', NULL),
      (${secondId}::uuid, ${groupId}::uuid, ${TEST_USER_ID}, 'apple_health', 'representative-second',
       'strength', 'strength', '2026-01-01 09:59:00+00', '2026-01-01 11:01:00+00',
       '{"second":2}', 'America/Los_Angeles', 'provider_timezone', 8)`);
  });

  it("keeps persisted identity when provider priority changes the representative", async () => {
    expect((await readProjection())[0]).toMatchObject({
      id: groupId,
      primary_activity_id: firstId,
    });
    await context.db.execute(
      sql`UPDATE fitness.provider_priority SET priority = 0 WHERE provider_id = 'apple_health'`,
    );
    expect((await readProjection())[0]).toMatchObject({
      id: groupId,
      primary_activity_id: secondId,
    });
  });

  it("prefers strength payload and preserves all member evidence when it arrives", async () => {
    const before = (await readProjection())[0];
    expect(before?.primary_activity_id).toBe(firstId);
    await context.db.execute(sql`INSERT INTO fitness.strength_set
      (activity_id, exercise_id, exercise_index, set_index, reps, weight_kg)
      VALUES (${secondId}::uuid, ${exerciseId}::uuid, 0, 0, 5, 0)`);
    const after = (await readProjection())[0];
    expect(after).toMatchObject({
      id: groupId,
      primary_activity_id: secondId,
      member_activity_ids: [firstId, secondId],
      source_providers: ["apple_health", "wahoo"],
      started_at: "2026-01-01 09:59:00+00",
      ended_at: "2026-01-01 11:01:00+00",
      raw: { first: 1, second: 2 },
      timezone: "America/Los_Angeles",
      local_time_source: "provider_timezone",
      perceived_exertion: 8,
    });
    expect(after?.source_external_ids.map((source) => source.memberActivityId).sort()).toEqual([
      firstId,
      secondId,
    ]);
    expect(after?.id).toBe(before?.id);
  });

  it.each(["cycling", "running", "strength", "walking", "climbing"])(
    "prefers specific %s classification over generic cardio",
    async (specificType) => {
      await context.db.execute(
        sql`UPDATE fitness.activity SET canonical_type = 'cardio', provider_type = 'cardio' WHERE id = ${firstId}::uuid`,
      );
      await context.db.execute(
        sql`UPDATE fitness.activity SET canonical_type = ${specificType}::fitness.canonical_activity_type, provider_type = ${specificType} WHERE id = ${secondId}::uuid`,
      );
      expect((await readProjection())[0]?.primary_activity_id).toBe(secondId);
    },
  );

  it("prefers a provider-type refinement before configured priority", async () => {
    await context.db.execute(
      sql`UPDATE fitness.activity SET provider_type = '  Functional_Strength  ' WHERE id = ${secondId}::uuid`,
    );
    expect((await readProjection())[0]?.primary_activity_id).toBe(secondId);
  });

  it.each([
    { reps: 0, weight: null, duration: null, distance: null },
    { reps: null, weight: 0, duration: null, distance: null },
    { reps: null, weight: null, duration: 30, distance: null },
    { reps: null, weight: null, duration: null, distance: 10 },
  ])(
    "prefers quantitative working sets over more incomplete or warmup sets: %j",
    async (values) => {
      await context.db.execute(sql`INSERT INTO fitness.strength_set
      (activity_id, exercise_id, exercise_index, set_index, set_type, reps)
      VALUES (${firstId}::uuid, ${exerciseId}::uuid, 0, 0, 'working', NULL),
        (${firstId}::uuid, ${exerciseId}::uuid, 0, 1, 'warmup', 10)`);
      await context.db.execute(sql`INSERT INTO fitness.strength_set
      (activity_id, exercise_id, exercise_index, set_index, reps, weight_kg, duration_seconds, distance_meters)
      VALUES (${secondId}::uuid, ${exerciseId}::uuid, 0, 0,
        ${values.reps}, ${values.weight}, ${values.duration}, ${values.distance})`);
      expect((await readProjection())[0]?.primary_activity_id).toBe(secondId);
    },
  );

  it("uses total set count when quantitative working-set counts tie", async () => {
    await context.db.execute(sql`INSERT INTO fitness.strength_set
      (activity_id, exercise_id, exercise_index, set_index)
      VALUES (${firstId}::uuid, ${exerciseId}::uuid, 0, 0),
        (${secondId}::uuid, ${exerciseId}::uuid, 0, 0),
        (${secondId}::uuid, ${exerciseId}::uuid, 0, 1)`);
    expect((await readProjection())[0]?.primary_activity_id).toBe(secondId);
  });

  it("uses distinct exercise count when set counts tie", async () => {
    const otherExerciseId = "00000000-0000-4000-8000-000000000305";
    await context.db.execute(sql`INSERT INTO fitness.exercise (id, name)
      VALUES (${otherExerciseId}::uuid, 'Pull-up') ON CONFLICT DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.strength_set
      (activity_id, exercise_id, exercise_index, set_index)
      VALUES (${firstId}::uuid, ${exerciseId}::uuid, 0, 0),
        (${firstId}::uuid, ${exerciseId}::uuid, 0, 1),
        (${secondId}::uuid, ${exerciseId}::uuid, 0, 0),
        (${secondId}::uuid, ${otherExerciseId}::uuid, 1, 0)`);
    expect((await readProjection())[0]?.primary_activity_id).toBe(secondId);
  });

  it.each(["", "   ", " STRENGTH "])(
    "normalizes an unrefined provider type %j before comparing priority",
    async (providerType) => {
      await context.db.execute(sql`UPDATE fitness.provider_priority
        SET priority = CASE provider_id WHEN 'wahoo' THEN 99 ELSE 1 END
        WHERE provider_id IN ('wahoo', 'apple_health')`);
      await context.db.execute(
        sql`UPDATE fitness.activity SET provider_type = ${providerType} WHERE id = ${firstId}::uuid`,
      );
      expect((await readProjection())[0]?.primary_activity_id).toBe(secondId);
    },
  );

  it("uses member UUID after equal payload, classification and priority", async () => {
    await context.db.execute(
      sql`UPDATE fitness.provider_priority SET priority = 1 WHERE provider_id = 'apple_health'`,
    );
    expect((await readProjection())[0]?.primary_activity_id).toBe(firstId);
  });
});

const groupedActivityBoundsRowSchema = z.object({
  started_at: z.string(),
  ended_at: z.string(),
  member_activity_ids: z.array(z.string()),
});

/**
 * Integration test verifying that overlapping activities are deduplicated
 * before ClickHouse activity analytics consume them.
 */
describe("Activity summary deduplication", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let testCtx: TestContext;
  let sessionCookie: string;
  let canonicalActivityId: string;
  let memberActivityId: string;
  let memberActivityIds: string[];
  let sensorStore: ActivitySensorStore;
  const baseUtcNow = new Date();

  function dateDaysAgo(daysAgo: number): string {
    const date = new Date(baseUtcNow);
    date.setUTCDate(date.getUTCDate() - daysAgo);
    return date.toISOString().slice(0, 10);
  }

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    const session = await createSession(testCtx.db, TEST_USER_ID);
    sessionCookie = `session=${session.sessionId}`;

    // Set up user profile with max_hr (required for TRIMP calculation)
    await testCtx.db.execute(
      sql`UPDATE fitness.user_profile
          SET max_hr = 190, resting_hr = 50
          WHERE id = ${TEST_USER_ID}`,
    );

    // Insert two providers with different priorities
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('wahoo', 'Wahoo', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('apple_health', 'Apple Health', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    // Insert overlapping cycling workouts from BOTH providers at two time points
    // spanning different ISO weeks. The ramp rate endpoint needs 2+ weeks of data
    // to produce week-over-week deltas, so a single activity isn't enough.
    // The v_activity dedup view should merge each pair into one canonical activity.
    const durationSec = 1800; // 30 minutes
    const activityOffsetsDaysAgo = [3, 14]; // two different ISO weeks

    for (const daysAgo of activityOffsetsDaysAgo) {
      const wahooResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
            ) VALUES (
              'wahoo', ${TEST_USER_ID}, ${`wahoo-overlap-${daysAgo}`}, 'cycling', 'cycling',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${durationSec}::int * INTERVAL '1 second',
              'Morning Ride'
            ) RETURNING id`,
      );
      const wahooActivityId = wahooResult[0]?.id;

      const appleResult = await testCtx.db.execute<{ id: string }>(
        sql`INSERT INTO fitness.activity (
              provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
            ) VALUES (
              'apple_health', ${TEST_USER_ID}, ${`apple-overlap-${daysAgo}`}, 'cycling', 'cycling',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + INTERVAL '10 seconds',
              CURRENT_TIMESTAMP - ${daysAgo}::int * INTERVAL '1 day' + ${durationSec}::int * INTERVAL '1 second' - INTERVAL '10 seconds',
              'Morning Ride'
            ) RETURNING id`,
      );
      const appleActivityId = appleResult[0]?.id;

      if (!wahooActivityId || !appleActivityId) {
        throw new Error("Expected overlapping activity insert to return ids");
      }
    }

    await testCtx.db.transaction((transaction) =>
      reconcileActivityGroups(transaction, TEST_USER_ID),
    );
    const aliasRows = await testCtx.db.execute<{ id: string; member_activity_ids: string[] }>(
      sql`SELECT id, member_activity_ids::text[] AS member_activity_ids
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}
            AND cardinality(member_activity_ids) > 1
          ORDER BY started_at DESC
          LIMIT 1`,
    );
    const aliasRow = aliasRows[0];
    const nonCanonicalMemberId = aliasRow?.member_activity_ids.find(
      (activityId) => activityId !== aliasRow.id,
    );
    if (!aliasRow || !nonCanonicalMemberId) {
      throw new Error("Expected overlapping activity aliases in fitness.v_activity");
    }
    canonicalActivityId = aliasRow.id;
    memberActivityIds = aliasRow.member_activity_ids;
    memberActivityId = nonCanonicalMemberId;

    await testCtx.db.execute(
      sql`UPDATE fitness.activity
          SET perceived_exertion = 8
          WHERE id = ${memberActivityId}::uuid`,
    );

    const previousLoadDate = dateDaysAgo(14);
    const recentLoadDate = dateDaysAgo(3);
    const previousLoadWeek = dateDaysAgo(14);
    const recentLoadWeek = dateDaysAgo(3);

    const queryMock: ActivitySensorStore["query"] = async (_schema, queryText) => {
      if (
        queryText.includes("analytics.weekly_endurance_ramp_rate") ||
        queryText.includes("analytics.daily_endurance_load")
      ) {
        return [
          {
            week: previousLoadWeek,
            ctl_start: 50,
            ctl_end: 50,
            ramp_rate: 0,
            is_deleted: 0,
          },
          {
            week: recentLoadWeek,
            ctl_start: 50,
            ctl_end: 52,
            ramp_rate: 2,
            is_deleted: 0,
          },
        ];
      }
      if (queryText.includes("SELECT date, resting_hr")) {
        return [{ date: previousLoadDate, resting_hr: 50 }];
      }
      if (queryText.includes("analytics.daily_activity_load")) {
        return [
          { day: previousLoadDate, trimp: 50 },
          { day: recentLoadDate, trimp: 52 },
        ];
      }
      if (queryText.includes("analytics.activity_location_sample")) {
        return [];
      }
      throw new Error(`Unrecognized query text: ${queryText}`);
    };

    sensorStore = {
      ...makeMockSensorStore(),
      query: vi.fn(queryMock),
      getActivitySummaries: vi.fn().mockResolvedValue([
        {
          activity_id: canonicalActivityId,
          avg_hr: 144,
          max_hr: 171,
          avg_power: 212,
          max_power: 390,
          avg_speed: 8.1,
          max_speed: 12.4,
          avg_cadence: 86,
          total_distance: 31_000,
          elevation_gain_m: 440,
          elevation_loss_m: 430,
          sample_count: 1800,
        },
      ]),
      getStream: vi.fn().mockResolvedValue([
        {
          recorded_at: "2026-04-20T15:00:00.000Z",
          heart_rate: 144,
          power: 212,
          speed: 8.1,
          cadence: 86,
          altitude: 120,
          lat: 47.6,
          lng: -122.3,
        },
      ]),
      getHeartRateZoneSeconds: vi.fn().mockResolvedValue([{ zone: 2, seconds: 120 }]),
    };

    const app = createApp(testCtx.db, sensorStore);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await testCtx?.cleanup();
  });

  async function query(path: string, input: Record<string, unknown> = {}) {
    const res = await fetch(`${baseUrl}/api/trpc/${path}?batch=1`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: sessionCookie },
      body: JSON.stringify({ "0": input }),
    });
    const data = await res.json();
    return { status: res.status, result: data[0] };
  }

  it("v_activity is a regular view so activity inserts are visible without refresh", async () => {
    const result = await testCtx.db.execute<{ exists: boolean }>(
      sql`SELECT EXISTS (
            SELECT 1
            FROM information_schema.views
            WHERE table_schema = 'fitness'
              AND table_name = 'v_activity'
          ) AS "exists"`,
    );
    expect(result[0]?.exists).toBe(true);

    const inserted = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES (
            'wahoo', ${TEST_USER_ID}, 'fresh-ride-visible-in-view', 'cycling', 'cycling',
            CURRENT_TIMESTAMP + INTERVAL '1 day',
            CURRENT_TIMESTAMP + INTERVAL '1 day' + INTERVAL '30 minutes',
            'Fresh Ride'
          )
          RETURNING id`,
    );
    const activityId = inserted[0]?.id;

    if (!activityId) {
      throw new Error("Expected fresh activity insert to return id");
    }

    try {
      await testCtx.db.transaction((transaction) =>
        reconcileActivityGroups(transaction, TEST_USER_ID),
      );
      const viewResult = await testCtx.db.execute<{ count: string }>(
        sql`SELECT COUNT(*)::text AS count
            FROM fitness.v_activity
            WHERE ${activityId}::uuid = ANY(member_activity_ids)`,
      );
      expect(Number(viewResult[0]?.count)).toBe(1);
    } finally {
      await testCtx.db.execute(sql`DELETE FROM fitness.activity WHERE id = ${activityId}`);
    }
  });

  it("v_activity contains only one canonical row per overlapping activity pair", async () => {
    const result = await testCtx.db.execute<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(Number(result[0]?.count)).toBe(2);
  });

  it("groups contained auto-started activities from another provider", async () => {
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('whoop', 'WHOOP', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    const activityIds = [
      "00000000-0000-4000-8000-000000000091",
      "00000000-0000-4000-8000-000000000092",
    ];
    const insertedIdArray = sql`ARRAY[${sql.join(
      activityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    )}]`;

    await testCtx.db.execute(sql`DELETE FROM fitness.activity WHERE id = ANY(${insertedIdArray})`);

    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES
            (
              ${activityIds[0]}::uuid,
              'apple_health', ${TEST_USER_ID}, 'apple-contained-run',
              'running',
              'running',
              TIMESTAMPTZ '2026-01-12 14:00:00+00',
              TIMESTAMPTZ '2026-01-12 15:00:00+00',
              'Outdoor Run'
            ),
            (
              ${activityIds[1]}::uuid,
              'whoop', ${TEST_USER_ID}, 'whoop-contained-run',
              'running',
              'running',
              TIMESTAMPTZ '2026-01-12 14:15:00+00',
              TIMESTAMPTZ '2026-01-12 15:00:00+00',
              'Outdoor Run'
            )`,
    );

    try {
      await testCtx.db.transaction((transaction) =>
        reconcileActivityGroups(transaction, TEST_USER_ID),
      );
      const groupedRows = await testCtx.db.execute<{ member_activity_ids: string[] }>(
        sql`SELECT member_activity_ids::text[] AS member_activity_ids
            FROM fitness.v_activity
            WHERE member_activity_ids && ${insertedIdArray}`,
      );

      expect(groupedRows).toHaveLength(1);
      expect(groupedRows[0]?.member_activity_ids.sort()).toEqual([...activityIds].sort());
    } finally {
      await testCtx.db.execute(
        sql`DELETE FROM fitness.activity WHERE id = ANY(${insertedIdArray})`,
      );
    }
  });

  it("uses the earliest start and latest end from every canonical activity member", async () => {
    const activityIds = [
      "00000000-0000-4000-8000-0000000000a1",
      "00000000-0000-4000-8000-0000000000a2",
    ];
    const insertedIdArray = sql`ARRAY[${sql.join(
      activityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    )}]`;

    await testCtx.db.execute(sql`DELETE FROM fitness.activity WHERE id = ANY(${insertedIdArray})`);
    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES
            (
              ${activityIds[0]}::uuid,
              'wahoo', ${TEST_USER_ID}, 'wahoo-expanded-bounds', 'cycling', 'cycling',
              TIMESTAMPTZ '2026-01-14 10:00:05+00',
              TIMESTAMPTZ '2026-01-14 11:00:00+00',
              'Expanded Bounds Ride'
            ),
            (
              ${activityIds[1]}::uuid,
              'apple_health', ${TEST_USER_ID}, 'apple-expanded-bounds', 'cycling', 'cycling',
              TIMESTAMPTZ '2026-01-14 10:00:00+00',
              TIMESTAMPTZ '2026-01-14 11:05:00+00',
              'Expanded Bounds Ride'
            )`,
    );

    try {
      await testCtx.db.transaction((transaction) =>
        reconcileActivityGroups(transaction, TEST_USER_ID),
      );
      const groupedRows = await executeWithSchema(
        testCtx.db,
        groupedActivityBoundsRowSchema,
        sql`SELECT
              started_at::text AS started_at,
              ended_at::text AS ended_at,
              member_activity_ids::text[] AS member_activity_ids
            FROM fitness.v_activity
            WHERE member_activity_ids && ${insertedIdArray}`,
      );

      expect(groupedRows).toHaveLength(1);
      expect(groupedRows[0]?.member_activity_ids.sort()).toEqual([...activityIds].sort());
      expect(groupedRows[0]?.started_at).toBe("2026-01-14 10:00:00+00");
      expect(groupedRows[0]?.ended_at).toBe("2026-01-14 11:05:00+00");
    } finally {
      await testCtx.db.execute(
        sql`DELETE FROM fitness.activity WHERE id = ANY(${insertedIdArray})`,
      );
    }
  });

  it("does not group active activities through a stale Apple tombstone", async () => {
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('whoop', 'WHOOP', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    const activityIds = [
      "00000000-0000-4000-8000-0000000000b1",
      "00000000-0000-4000-8000-0000000000b2",
      "00000000-0000-4000-8000-0000000000b3",
      "00000000-0000-4000-8000-0000000000b4",
    ];
    const insertedIdArray = sql`ARRAY[${sql.join(
      activityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    )}]`;

    await testCtx.db.execute(sql`DELETE FROM fitness.activity WHERE id = ANY(${insertedIdArray})`);

    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, canonical_type, provider_type, external_id,
            started_at, ended_at, provider_absent_at, name, raw
          ) VALUES
            (
              ${activityIds[0]}::uuid,
              'wahoo', ${TEST_USER_ID}, 'running', 'running', 'wahoo-stale-bridge-left',
              TIMESTAMPTZ '2026-01-13 10:00:00+00',
              TIMESTAMPTZ '2026-01-13 10:30:00+00',
              NULL,
              'Left Run',
              '{}'::jsonb
            ),
            (
              ${activityIds[1]}::uuid,
              'whoop', ${TEST_USER_ID}, 'running', 'running', 'whoop-stale-bridge-right',
              TIMESTAMPTZ '2026-01-13 10:40:00+00',
              TIMESTAMPTZ '2026-01-13 11:10:00+00',
              NULL,
              'Right Run',
              '{}'::jsonb
            ),
            (
              ${activityIds[2]}::uuid,
              'apple_health', ${TEST_USER_ID}, 'running', 'running', 'apple-stale-bridge',
              TIMESTAMPTZ '2026-01-13 10:05:00+00',
              TIMESTAMPTZ '2026-01-13 11:05:00+00',
              NOW(),
              'Stale Apple Bridge',
              jsonb_build_object(
                'metadata',
                jsonb_build_object(
                  'HKMetadataKeySyncIdentifier', 'stale-bridge-sync-id',
                  'HKMetadataKeySyncVersion', '1'
                )
              )
            ),
            (
              ${activityIds[3]}::uuid,
              'apple_health', ${TEST_USER_ID}, 'running', 'running', 'apple-current-sibling',
              TIMESTAMPTZ '2026-01-13 12:00:00+00',
              TIMESTAMPTZ '2026-01-13 12:30:00+00',
              NULL,
              'Current Apple Sibling',
              jsonb_build_object(
                'metadata',
                jsonb_build_object(
                  'HKMetadataKeySyncIdentifier', 'stale-bridge-sync-id',
                  'HKMetadataKeySyncVersion', '2'
                )
              )
            )`,
    );

    try {
      await testCtx.db.transaction((transaction) =>
        reconcileActivityGroups(transaction, TEST_USER_ID),
      );
      const activeIdArray = sql`ARRAY[${activityIds[0]}::uuid, ${activityIds[1]}::uuid]`;
      const groupedRows = await testCtx.db.execute<{ member_activity_ids: string[] }>(
        sql`SELECT member_activity_ids::text[] AS member_activity_ids
            FROM fitness.v_activity
            WHERE member_activity_ids && ${activeIdArray}
            ORDER BY started_at`,
      );

      expect(groupedRows).toHaveLength(2);
      expect(
        groupedRows.some((row) =>
          activityIds
            .slice(0, 2)
            .every((activityId) => row.member_activity_ids.includes(activityId)),
        ),
      ).toBe(false);
    } finally {
      await testCtx.db.execute(
        sql`DELETE FROM fitness.activity WHERE id = ANY(${insertedIdArray})`,
      );
    }
  });

  it("projects every member of a reconciled transitive overlap component", async () => {
    const chainActivityIds = [
      "00000000-0000-4000-8000-000000000101",
      "00000000-0000-4000-8000-000000000102",
      "00000000-0000-4000-8000-000000000103",
      "00000000-0000-4000-8000-000000000104",
    ];
    const insertedIdArray = sql`ARRAY[${sql.join(
      chainActivityIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    )}]`;

    await testCtx.db.execute(sql`DELETE FROM fitness.activity WHERE id = ANY(${insertedIdArray})`);

    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES
            (
              ${chainActivityIds[0]}::uuid,
              'wahoo', ${TEST_USER_ID}, 'chain-activity-a',
              'cycling',
              'cycling',
              TIMESTAMPTZ '2026-01-10 10:00:00+00',
              TIMESTAMPTZ '2026-01-10 10:30:00+00',
              'Two-hop chain A'
            ),
            (
              ${chainActivityIds[1]}::uuid,
              'wahoo', ${TEST_USER_ID}, 'chain-activity-b',
              'cycling',
              'cycling',
              TIMESTAMPTZ '2026-01-10 10:02:00+00',
              TIMESTAMPTZ '2026-01-10 10:32:00+00',
              'Two-hop chain B'
            ),
            (
              ${chainActivityIds[2]}::uuid,
              'wahoo', ${TEST_USER_ID}, 'chain-activity-c',
              'cycling',
              'cycling',
              TIMESTAMPTZ '2026-01-10 10:04:00+00',
              TIMESTAMPTZ '2026-01-10 10:34:00+00',
              'Two-hop chain C'
            ),
            (
              ${chainActivityIds[3]}::uuid,
              'wahoo', ${TEST_USER_ID}, 'chain-activity-d',
              'cycling',
              'cycling',
              TIMESTAMPTZ '2026-01-10 10:06:00+00',
              TIMESTAMPTZ '2026-01-10 10:36:00+00',
              'Two-hop chain D'
            )`,
    );

    try {
      await testCtx.db.transaction((transaction) =>
        reconcileActivityGroups(transaction, TEST_USER_ID),
      );
      const groupedRows = await testCtx.db.execute<{ member_activity_ids: string[] }>(
        sql`SELECT member_activity_ids::text[] AS member_activity_ids
            FROM fitness.v_activity
            WHERE member_activity_ids && ${insertedIdArray}
            ORDER BY started_at`,
      );

      expect(groupedRows).toHaveLength(1);
      expect(groupedRows[0]?.member_activity_ids).toEqual(chainActivityIds);
    } finally {
      await testCtx.db.execute(
        sql`DELETE FROM fitness.activity WHERE id = ANY(${insertedIdArray})`,
      );
    }
  });

  it("ramp rate does not double-count overlapping activities", async () => {
    await queryCache.invalidateAll();
    const { status, result } = await query("cyclingAdvanced.rampRate", {
      days: 30,
    });
    expect(status).toBe(200);

    const data = result.result.data;
    // With two 30-min activities at ~155 bpm across 2 ISO weeks, the ramp rate
    // should be modest. If double-counted, the load would be 2x and spike.
    expect(data.weeks.length).toBeGreaterThan(0);
    for (const week of data.weeks) {
      expect(Math.abs(week.rampRate)).toBeLessThan(10);
    }
  });

  it("resolves activity endpoints from a non-canonical member activity id", async () => {
    await queryCache.invalidateAll();

    const byId = await query("activity.byId", { id: memberActivityId });
    expect(byId.status).toBe(200);
    expect(byId.result.result.data).toMatchObject({
      id: canonicalActivityId,
      perceivedExertion: 8,
      avgHr: 144,
      avgPower: 212,
      sampleCount: 1800,
    });

    const stream = await query("activity.stream", { id: memberActivityId, maxPoints: 100 });
    expect(stream.status).toBe(200);
    expect(stream.result.result.data).toEqual([
      {
        recordedAt: "2026-04-20T15:00:00.000Z",
        heartRate: 144,
        power: 212,
        speed: 8.1,
        cadence: 86,
        altitude: 120,
        lat: 47.6,
        lng: -122.3,
      },
    ]);

    const heartRateZones = await query("activity.hrZones", { id: memberActivityId });
    expect(heartRateZones.status).toBe(200);
    expect(heartRateZones.result.result.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ zone: 2, seconds: 120 })]),
    );

    expect(sensorStore.getActivitySummaries).toHaveBeenCalledWith([canonicalActivityId]);
    expect(sensorStore.getStream).toHaveBeenCalledWith(
      expect.objectContaining({
        activityId: canonicalActivityId,
        memberActivityIds,
      }),
      100,
    );
    expect(sensorStore.getHeartRateZoneSeconds).toHaveBeenCalledWith(
      expect.objectContaining({
        activityId: canonicalActivityId,
        memberActivityIds,
      }),
    );
  });

  it("hides deduped activities when any grouped provider source is tombstoned", async () => {
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('whoop', 'WHOOP', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    const startedAt = "2026-01-15T10:00:00Z";
    const endedAt = "2026-01-15T10:30:00Z";
    const wahooInsert = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES (
            'wahoo', ${TEST_USER_ID}, 'wahoo-tombstone-dedup', 'cycling', 'cycling',
            ${startedAt}::timestamptz,
            ${endedAt}::timestamptz,
            'Tombstone Dedup Ride'
          ) RETURNING id`,
    );
    const wahooActivityId = wahooInsert[0]?.id;

    const whoopInsert = await testCtx.db.execute<{ id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, canonical_type, provider_type, started_at, ended_at, external_id, provider_absent_at
          ) VALUES (
            'whoop', ${TEST_USER_ID}, 'cycling', 'cycling',
            ${startedAt}::timestamptz,
            ${endedAt}::timestamptz,
            'whoop-tombstone-dedup',
            NOW()
          ) RETURNING id`,
    );
    const whoopActivityId = whoopInsert[0]?.id;
    await testCtx.db.execute(sql`UPDATE fitness.activity
      SET group_id = (SELECT group_id FROM fitness.activity WHERE id = ${wahooActivityId}::uuid)
      WHERE id = ${whoopActivityId}::uuid`);

    try {
      await testCtx.db.transaction((transaction) =>
        reconcileActivityGroups(transaction, TEST_USER_ID),
      );
      expect(wahooActivityId).toBeDefined();
      expect(whoopActivityId).toBeDefined();

      const viewRows = await testCtx.db.execute<{
        id: string;
      }>(
        sql`SELECT id
            FROM fitness.v_activity
            WHERE user_id = ${TEST_USER_ID}
              AND ${wahooActivityId}::uuid = ANY(member_activity_ids)`,
      );

      expect(viewRows).toHaveLength(0);
    } finally {
      await testCtx.db.execute(
        sql`DELETE FROM fitness.activity WHERE id IN (${wahooActivityId}::uuid, ${whoopActivityId}::uuid)`,
      );
    }
  });

  it("soft-deletes all raw member rows when deleting a deduped activity member", async () => {
    const inserted = await testCtx.db.execute<{ id: string; provider_id: string }>(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
          ) VALUES
          (
            'wahoo', ${TEST_USER_ID}, 'wahoo-delete-me',
            'cycling',
            'cycling',
            CURRENT_TIMESTAMP + INTERVAL '3 days',
            CURRENT_TIMESTAMP + INTERVAL '3 days' + INTERVAL '30 minutes',
            'Delete Me'
          ),
          (
            'apple_health', ${TEST_USER_ID}, 'apple-delete-me',
            'cycling',
            'cycling',
            CURRENT_TIMESTAMP + INTERVAL '3 days' + INTERVAL '10 seconds',
            CURRENT_TIMESTAMP + INTERVAL '3 days' + INTERVAL '29 minutes 50 seconds',
            'Delete Me'
          )
          RETURNING id, provider_id`,
    );
    const insertedIds = inserted.map((row) => row.id);
    const insertedIdArray = sql`ARRAY[${sql.join(
      insertedIds.map((activityId) => sql`${activityId}::uuid`),
      sql`, `,
    )}]`;
    await testCtx.db.transaction((transaction) =>
      reconcileActivityGroups(transaction, TEST_USER_ID),
    );
    const aliasRows = await testCtx.db.execute<{ id: string; member_activity_ids: string[] }>(
      sql`SELECT id, member_activity_ids::text[] AS member_activity_ids
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}
            AND member_activity_ids && ${insertedIdArray}
          LIMIT 1`,
    );
    const aliasRow = aliasRows[0];
    const activityIdToDelete = aliasRow?.member_activity_ids.find(
      (activityId) => activityId !== aliasRow.id,
    );

    try {
      await testCtx.db.transaction((transaction) =>
        reconcileActivityGroups(transaction, TEST_USER_ID),
      );
      expect(insertedIds).toHaveLength(2);
      expect(aliasRow?.member_activity_ids).toEqual(expect.arrayContaining(insertedIds));
      expect(activityIdToDelete).toBeDefined();

      const { status, result } = await query("activity.delete", { id: activityIdToDelete });
      expect(status).toBe(200);
      expect(result.result.data).toEqual({ success: true });

      const remainingRows = await testCtx.db.execute<{
        id: string;
        deleted_at: Date | null;
      }>(
        sql`SELECT id, deleted_at
            FROM fitness.activity
            WHERE id = ANY(${insertedIdArray})
            ORDER BY id`,
      );
      expect(remainingRows).toHaveLength(2);
      expect(remainingRows.every((row) => row.deleted_at !== null)).toBe(true);
    } finally {
      await testCtx.db.execute(
        sql`DELETE FROM fitness.activity WHERE id = ANY(${insertedIdArray})`,
      );
    }
  });
});
