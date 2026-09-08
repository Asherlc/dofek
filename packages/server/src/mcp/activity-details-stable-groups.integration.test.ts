import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { reconcileActivityGroups } from "../../../../src/db/activity-group-reconciliation.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  createClickHouseTestActivitySensorStore,
  getClickHouseTestClient,
  seedClickHouseMetricStreamRows,
  syncClickHouseTestActivitySensorStore,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { activityDetailsOutputSchema } from "./tool-output.ts";
import { createDofekMcpServer } from "./tools.ts";

const ids = {
  firstStrengthGroup: "81000000-0000-4000-8000-000000000001",
  firstStrengthApple: "81000000-0000-4000-8000-000000000011",
  firstStrengthStrong: "81000000-0000-4000-8000-000000000012",
  firstStrengthWhoop: "81000000-0000-4000-8000-000000000013",
  firstStrengthAlias: "81000000-0000-4000-8000-000000000091",
  secondStrengthGroup: "82000000-0000-4000-8000-000000000001",
  secondStrengthApple: "82000000-0000-4000-8000-000000000011",
  secondStrengthStrong: "82000000-0000-4000-8000-000000000012",
  firstCommuteGroup: "83000000-0000-4000-8000-000000000001",
  firstCommuteWhoop: "83000000-0000-4000-8000-000000000011",
  firstCommutePeloton: "83000000-0000-4000-8000-000000000012",
  secondCommuteGroup: "84000000-0000-4000-8000-000000000001",
  secondCommuteWhoop: "84000000-0000-4000-8000-000000000011",
  secondCommutePeloton: "84000000-0000-4000-8000-000000000012",
  firstStrengthExercise: "85000000-0000-4000-8000-000000000001",
  secondStrengthExercise: "85000000-0000-4000-8000-000000000002",
} as const;

const primaryActivitySchema = z.object({ primary_activity_id: z.string().uuid() });
const clickHousePrimaryActivitySchema = z.array(
  z.object({ activity_id: z.string().uuid(), primary_activity_id: z.string().uuid() }),
);

function populatedPaths(value: unknown, prefix = ""): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix ? [prefix] : [];
    return value.flatMap((item, index) => populatedPaths(item, `${prefix}[${index}]`));
  }
  if (typeof value !== "object") return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) =>
    populatedPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("MCP activity details stable group contract", () => {
  let context: TestContext;
  let sensorStore: ActivitySensorStore;
  let mcpServer: McpServer;
  let client: Client;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        ('apple_health', 'Apple Health', ${TEST_USER_ID}),
        ('strong-csv', 'Strong CSV', ${TEST_USER_ID}),
        ('whoop', 'WHOOP', ${TEST_USER_ID}),
        ('peloton', 'Peloton', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.provider_priority (provider_id, priority)
      VALUES
        ('apple_health', 30),
        ('strong-csv', 10),
        ('whoop', 20),
        ('peloton', 1)
      ON CONFLICT (provider_id) DO UPDATE SET priority = EXCLUDED.priority`);
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id, anchor_activity_id)
      VALUES
        (${ids.firstStrengthGroup}, ${TEST_USER_ID}, ${ids.firstStrengthApple}),
        (${ids.secondStrengthGroup}, ${TEST_USER_ID}, ${ids.secondStrengthApple}),
        (${ids.firstCommuteGroup}, ${TEST_USER_ID}, ${ids.firstCommuteWhoop}),
        (${ids.secondCommuteGroup}, ${TEST_USER_ID}, ${ids.secondCommuteWhoop}),
        (${ids.firstStrengthAlias}, ${TEST_USER_ID}, NULL)`);
    await context.db.execute(sql`INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, timezone, start_utc_offset_minutes,
        end_utc_offset_minutes, local_time_source, raw
      ) VALUES
        (${ids.firstStrengthApple}, ${ids.firstStrengthGroup}, 'apple_health', ${TEST_USER_ID},
          'synthetic-strength-one-apple', 'strength', 'strength',
          '2099-04-10T17:00:00Z', '2099-04-10T18:00:00Z', 'Fixture Session Alpha', 'Strong',
          'America/Los_Angeles', -420, -420, 'device_timezone', '{"sourceName":"Strong"}'),
        (${ids.firstStrengthStrong}, ${ids.firstStrengthGroup}, 'strong-csv', ${TEST_USER_ID},
          'synthetic-strength-one-strong', 'strength', 'strength_training',
          '2099-04-10T17:00:00Z', '2099-04-10T18:00:00Z', 'Fixture Session Alpha', 'Strong',
          'America/Los_Angeles', -420, -420, 'device_timezone', '{"sourceName":"Strong"}'),
        (${ids.firstStrengthWhoop}, ${ids.firstStrengthGroup}, 'whoop', ${TEST_USER_ID},
          'synthetic-strength-one-whoop', 'strength', 'strength',
          '2099-04-10T17:00:10Z', '2099-04-10T17:59:50Z', 'Fixture Session Alpha', 'WHOOP',
          'America/Los_Angeles', -420, -420, 'device_timezone', '{"sourceName":"WHOOP"}'),
        (${ids.secondStrengthApple}, ${ids.secondStrengthGroup}, 'apple_health', ${TEST_USER_ID},
          'synthetic-strength-two-apple', 'strength', 'strength',
          '2099-04-12T17:00:00Z', '2099-04-12T18:00:00Z', 'Fixture Session Beta', 'Strong',
          'America/Los_Angeles', -420, -420, 'device_timezone', '{"sourceName":"Strong"}'),
        (${ids.secondStrengthStrong}, ${ids.secondStrengthGroup}, 'strong-csv', ${TEST_USER_ID},
          'synthetic-strength-two-strong', 'strength', 'strength_training',
          '2099-04-12T17:00:00Z', '2099-04-12T18:00:00Z', 'Fixture Session Beta', 'Strong',
          'America/Los_Angeles', -420, -420, 'device_timezone', '{"sourceName":"Strong"}'),
        (${ids.firstCommuteWhoop}, ${ids.firstCommuteGroup}, 'whoop', ${TEST_USER_ID},
          'synthetic-commute-one-whoop', 'cycling', 'commuting',
          '2099-04-14T15:00:00Z', '2099-04-14T15:30:00Z', 'Fixture Ride Alpha', 'WHOOP',
          'America/Los_Angeles', -420, -420, 'device_timezone', '{}'),
        (${ids.firstCommutePeloton}, ${ids.firstCommuteGroup}, 'peloton', ${TEST_USER_ID},
          'synthetic-commute-one-peloton', 'cardio', 'cardio',
          '2099-04-14T15:00:10Z', '2099-04-14T15:29:50Z', 'Fixture Ride Alpha', 'Peloton',
          'America/Los_Angeles', -420, -420, 'device_timezone', '{}'),
        (${ids.secondCommuteWhoop}, ${ids.secondCommuteGroup}, 'whoop', ${TEST_USER_ID},
          'synthetic-commute-two-whoop', 'cycling', 'commuting',
          '2099-04-16T15:00:00Z', '2099-04-16T15:45:00Z', 'Fixture Ride Beta', 'WHOOP',
          'America/Los_Angeles', -420, -420, 'device_timezone', '{}'),
        (${ids.secondCommutePeloton}, ${ids.secondCommuteGroup}, 'peloton', ${TEST_USER_ID},
          'synthetic-commute-two-peloton', 'cardio', 'cardio',
          '2099-04-16T15:00:10Z', '2099-04-16T15:44:50Z', 'Fixture Ride Beta', 'Peloton',
          'America/Los_Angeles', -420, -420, 'device_timezone', '{}')`);
    await context.db.execute(sql`INSERT INTO fitness.activity_group_alias
      (alias_id, group_id, user_id, reason)
      VALUES (${ids.firstStrengthAlias}, ${ids.firstStrengthGroup}, ${TEST_USER_ID}, 'merge')`);
    await context.db.execute(sql`INSERT INTO fitness.exercise (id, name, muscle_groups, equipment)
      VALUES
        (${ids.firstStrengthExercise}, 'Fixture Movement Alpha', ARRAY['back', 'glutes'], 'barbell'),
        (${ids.secondStrengthExercise}, 'Fixture Movement Beta', ARRAY['quadriceps'], 'machine')`);
    await context.db.execute(sql`INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type,
        weight_kg, reps, duration_seconds
      ) VALUES
        (${ids.firstStrengthStrong}, ${ids.firstStrengthExercise}, 0, 0, 'working', 12.345, 2, NULL),
        (${ids.firstStrengthStrong}, ${ids.firstStrengthExercise}, 0, 1, 'rest', 0, 0, 47),
        (${ids.firstStrengthStrong}, ${ids.firstStrengthExercise}, 0, 2, 'working', 23.456, 4, NULL),
        (${ids.firstStrengthStrong}, ${ids.firstStrengthExercise}, 0, 3, 'working', 34.567, 6, NULL),
        (${ids.firstStrengthStrong}, ${ids.firstStrengthExercise}, 0, 4, 'working', 45.678, 8, NULL),
        (${ids.firstStrengthStrong}, ${ids.firstStrengthExercise}, 0, 5, 'rest', 0, 0, 83),
        (${ids.firstStrengthStrong}, ${ids.firstStrengthExercise}, 0, 6, 'working', 56.789, 12, NULL),
        (${ids.secondStrengthStrong}, ${ids.secondStrengthExercise}, 0, 0, 'working', 17.89, 6, NULL)`);

    await context.db.transaction((transaction) =>
      reconcileActivityGroups(transaction, TEST_USER_ID),
    );
    sensorStore = await createClickHouseTestActivitySensorStore(context);
    await seedClickHouseMetricStreamRows(context, [
      {
        activityId: ids.firstCommuteWhoop,
        userId: TEST_USER_ID,
        recordedAt: "2099-04-14T15:05:00Z",
        channel: "heart_rate",
        providerId: "whoop",
        sourceType: "api",
        scalar: 71,
      },
      {
        activityId: ids.firstCommuteWhoop,
        userId: TEST_USER_ID,
        recordedAt: "2099-04-14T15:10:00Z",
        channel: "heart_rate",
        providerId: "whoop",
        sourceType: "api",
        scalar: 79,
      },
      {
        activityId: ids.secondCommuteWhoop,
        userId: TEST_USER_ID,
        recordedAt: "2099-04-16T15:05:00Z",
        channel: "heart_rate",
        providerId: "whoop",
        sourceType: "api",
        scalar: 83,
      },
      {
        activityId: ids.secondCommuteWhoop,
        userId: TEST_USER_ID,
        recordedAt: "2099-04-16T15:10:00Z",
        channel: "heart_rate",
        providerId: "whoop",
        sourceType: "api",
        scalar: 97,
      },
    ]);

    mcpServer = createDofekMcpServer({
      db: context.db,
      userId: TEST_USER_ID,
      scopes: ["activity:read"],
      timezone: "America/Los_Angeles",
      sensorStore,
    });
    client = new Client({ name: "stable-activity-group-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await mcpServer?.close();
    await context?.cleanup();
  });

  async function getDetails(activityId: string) {
    const response = await client.callTool({
      name: "get_activity_details",
      arguments: { activity_id: activityId },
    });
    expect(response.isError).not.toBe(true);
    return activityDetailsOutputSchema.parse(response.structuredContent).result;
  }

  it("keeps structured and sensor payloads visible while representative evidence changes", async () => {
    const beforePrimary = primaryActivitySchema.parse(
      (
        await context.db.execute(sql`SELECT primary_activity_id::text AS primary_activity_id
          FROM fitness.v_activity WHERE id = ${ids.firstStrengthGroup}::uuid`)
      )[0],
    );
    expect(beforePrimary.primary_activity_id).toBe(ids.firstStrengthStrong);

    const before = await getDetails(ids.firstStrengthGroup);
    const firstMovement = before.strength_exercises.find(
      (exercise) => exercise.exerciseName === "Fixture Movement Alpha",
    );
    expect(before.activity).toMatchObject({
      id: ids.firstStrengthGroup,
      canonical_type: "strength",
      source_providers: ["apple_health", "strong-csv", "whoop"],
      timezone: "America/Los_Angeles",
      start_utc_offset_minutes: -420,
      local_time_source: "device_timezone",
    });
    expect(firstMovement?.sets.map(({ setIndex }) => setIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(firstMovement?.sets.filter(({ setType }) => setType === "working")).toMatchObject([
      { weightKg: 12.345, reps: 2 },
      { weightKg: 23.456, reps: 4 },
      { weightKg: 34.567, reps: 6 },
      { weightKg: 45.678, reps: 8 },
      { weightKg: 56.789, reps: 12 },
    ]);
    expect(firstMovement?.sets.filter(({ setType }) => setType === "rest")).toEqual([
      expect.objectContaining({ setIndex: 1, weightKg: 0, reps: 0, durationSeconds: 47 }),
      expect.objectContaining({ setIndex: 5, weightKg: 0, reps: 0, durationSeconds: 83 }),
    ]);

    const secondStrength = await getDetails(ids.secondStrengthGroup);
    expect(secondStrength.strength_exercises).not.toHaveLength(0);
    expect(secondStrength.strength_exercises[0]?.sets[0]).toMatchObject({
      weightKg: 17.89,
      reps: 6,
    });

    const firstCommute = await getDetails(ids.firstCommuteGroup);
    const secondCommute = await getDetails(ids.secondCommuteGroup);
    const allRepresentatives = clickHousePrimaryActivitySchema.parse(
      await (
        await getClickHouseTestClient(context).query({
          query: `SELECT
              toString(activity_id) AS activity_id,
              toString(primary_activity_id) AS primary_activity_id
            FROM analytics.deduped_activities FINAL
            WHERE user_id = {userId:UUID}
              AND is_deleted = 0
            ORDER BY activity_id`,
          query_params: { userId: TEST_USER_ID },
          format: "JSONEachRow",
        })
      ).json(),
    );
    const commuteGroupIds = new Set<string>([ids.firstCommuteGroup, ids.secondCommuteGroup]);
    const commuteRepresentatives = allRepresentatives.filter(({ activity_id }) =>
      commuteGroupIds.has(activity_id),
    );
    expect(commuteRepresentatives).toEqual([
      {
        activity_id: ids.firstCommuteGroup,
        primary_activity_id: ids.firstCommuteWhoop,
      },
      {
        activity_id: ids.secondCommuteGroup,
        primary_activity_id: ids.secondCommuteWhoop,
      },
    ]);
    expect(firstCommute.activity).toMatchObject({
      id: ids.firstCommuteGroup,
      canonical_type: "cycling",
      raw_type: "commuting",
      avg_hr: 75,
    });
    expect(secondCommute.activity).toMatchObject({
      id: ids.secondCommuteGroup,
      canonical_type: "cycling",
      raw_type: "commuting",
      avg_hr: 90,
    });

    await context.db.execute(sql`INSERT INTO fitness.strength_set (
        activity_id, exercise_id, exercise_index, set_index, set_type,
        weight_kg, reps, duration_seconds
      )
      SELECT ${ids.firstStrengthApple}::uuid, exercise_id, exercise_index, set_index, set_type,
        weight_kg, reps, duration_seconds
      FROM fitness.strength_set
      WHERE activity_id = ${ids.firstStrengthStrong}::uuid`);
    await context.db.execute(sql`UPDATE fitness.provider_priority
      SET priority = CASE provider_id WHEN 'apple_health' THEN 0 WHEN 'strong-csv' THEN 50 ELSE priority END
      WHERE provider_id IN ('apple_health', 'strong-csv')`);
    await context.db.transaction((transaction) =>
      reconcileActivityGroups(transaction, TEST_USER_ID),
    );
    await syncClickHouseTestActivitySensorStore(context);

    const afterPrimary = primaryActivitySchema.parse(
      (
        await context.db.execute(sql`SELECT primary_activity_id::text AS primary_activity_id
          FROM fitness.v_activity WHERE id = ${ids.firstStrengthGroup}::uuid`)
      )[0],
    );
    expect(afterPrimary.primary_activity_id).toBe(ids.firstStrengthApple);

    const after = await getDetails(ids.firstStrengthGroup);
    expect(after.activity.id).toBe(ids.firstStrengthGroup);
    expect(after.strength_exercises).toEqual(before.strength_exercises);
    expect(populatedPaths(after).sort()).toEqual(populatedPaths(before).sort());

    const fromMember = await getDetails(ids.firstStrengthStrong);
    const fromAlias = await getDetails(ids.firstStrengthAlias);
    expect(fromMember.activity).toMatchObject({
      id: ids.firstStrengthGroup,
      resolved_from: ids.firstStrengthStrong,
    });
    expect(fromAlias.activity).toMatchObject({
      id: ids.firstStrengthGroup,
      resolved_from: ids.firstStrengthAlias,
    });
    expect(fromMember.strength_exercises).toEqual(after.strength_exercises);
    expect(fromAlias.strength_exercises).toEqual(after.strength_exercises);

    const refreshedCommute = await getDetails(ids.firstCommutePeloton);
    expect(refreshedCommute.activity).toMatchObject({
      id: ids.firstCommuteGroup,
      resolved_from: ids.firstCommutePeloton,
      canonical_type: "cycling",
      raw_type: "commuting",
      avg_hr: 75,
    });
  });
});
