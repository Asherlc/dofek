import { Client } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestRawSensorStore,
  insertClickHouseMetricStreamRows,
} from "../routers/clickhouse-integration-test-helpers.ts";
import { recoveryTrainingSeriesOutputSchema } from "./recovery-training-series-output.ts";
import { mcpOutputSchemas } from "./tool-output.ts";
import { createDofekMcpServer } from "./tools.ts";

const zone = "America/Los_Angeles";
const night = "91000000-0000-4000-8000-000000000011";
const duplicate = "91000000-0000-4000-8000-000000000012";
const nap = "91000000-0000-4000-8000-000000000013";
const lateWorkout = "92000000-0000-4000-8000-000000000002";

describe("read-only relationship analysis through MCP", () => {
  let context: TestContext;
  let server: McpServer;
  let client: Client;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name, user_id) VALUES
      ('whoop', 'WHOOP', ${TEST_USER_ID}),
      ('apple_health', 'Apple Health', ${TEST_USER_ID}),
      ('dofek', 'Dofek', ${TEST_USER_ID})
      ON CONFLICT (id) DO NOTHING`);
    await context.db.execute(sql`INSERT INTO fitness.provider_priority (provider_id, priority, sleep_priority) VALUES
      ('whoop', 10, 10), ('apple_health', 20, 20), ('dofek', 30, 30)
      ON CONFLICT (provider_id) DO UPDATE SET sleep_priority = EXCLUDED.sleep_priority`);
    await context.db.execute(sql`INSERT INTO fitness.sleep_session
      (id, user_id, provider_id, external_id, started_at, ended_at, duration_minutes, awake_minutes,
       staging_available, sleep_type, is_nap, timezone, local_time_source, source_name) VALUES
      ('91000000-0000-4000-8000-000000000001', ${TEST_USER_ID}, 'whoop', 'analysis-sept',
        '2026-09-03T05:00:00Z', '2026-09-03T15:00:00Z', 550, 50,
        true, 'sleep', false, 'America/Los_Angeles', 'device_timezone', 'WHOOP 4.0'),
      ('91000000-0000-4000-8000-000000000002', ${TEST_USER_ID}, 'whoop', 'analysis-dst',
        '2026-11-01T05:30:00Z', '2026-11-01T14:30:00Z', 510, 30,
        true, 'sleep', false, 'America/New_York', 'device_timezone', 'WHOOP 4.0'),
      ('91000000-0000-4000-8000-000000000003', ${TEST_USER_ID}, 'whoop', 'analysis-nov11',
        '2026-11-11T06:00:00Z', '2026-11-11T15:00:00Z', 500, 40,
        true, 'sleep', false, 'America/Los_Angeles', 'device_timezone', 'WHOOP 4.0'),
      ('91000000-0000-4000-8000-000000000004', ${TEST_USER_ID}, 'whoop', 'analysis-early-night',
        '2026-11-12T05:30:00Z', '2026-11-12T15:00:00Z', 520, 50,
        true, 'sleep', false, 'America/Los_Angeles', 'device_timezone', 'WHOOP 4.0'),
      ('91000000-0000-4000-8000-000000000005', ${TEST_USER_ID}, 'whoop', 'analysis-nov18',
        '2026-11-18T06:00:00Z', '2026-11-18T15:00:00Z', 500, 40,
        true, 'sleep', false, 'America/Los_Angeles', 'device_timezone', 'WHOOP 5.0'),
      (${night}, ${TEST_USER_ID}, 'whoop', 'analysis-late-night',
        '2026-11-19T06:51:43Z', '2026-11-19T15:00:00Z', 448, 40,
        true, 'sleep', false, 'America/Los_Angeles', 'device_timezone', 'WHOOP 5.0'),
      (${duplicate}, ${TEST_USER_ID}, 'apple_health', 'analysis-duplicate-night',
        '2026-11-19T10:00:00Z', '2026-11-19T15:00:00Z', 300, null,
        false, null, false, 'America/New_York', 'device_timezone', 'Apple Watch'),
      (${nap}, ${TEST_USER_ID}, 'whoop', 'analysis-nap',
        '2026-11-19T20:00:00Z', '2026-11-19T20:30:00Z', 30, null,
        false, 'nap', true, null, 'unknown', 'WHOOP 5.0'),
      ('91000000-0000-4000-8000-000000000014', ${TEST_USER_ID}, 'whoop', 'analysis-split-date-main',
        '2026-11-20T05:30:00Z', '2026-11-20T15:00:00Z', 520, 50,
        true, 'sleep', false, 'America/Los_Angeles', 'device_timezone', 'WHOOP 5.0'),
      ('91000000-0000-4000-8000-000000000015', ${TEST_USER_ID}, 'apple_health', 'analysis-split-date-copy',
        '2026-11-20T09:00:00Z', '2026-11-20T15:00:00Z', 360, null,
        false, null, false, null, 'unknown', 'Apple Watch'),
      ('91000000-0000-4000-8000-000000000016', ${TEST_USER_ID}, 'whoop', 'analysis-open-sleep',
        '2026-11-21T08:00:00Z', null, null, null,
        false, 'sleep', false, null, 'unknown', 'WHOOP 5.0'),
      ('91000000-0000-4000-8000-000000000017', ${TEST_USER_ID}, 'whoop', 'analysis-separate-main-one',
        '2026-11-22T08:00:00Z', '2026-11-22T13:00:00Z', 300, null,
        false, 'sleep', false, null, 'unknown', 'WHOOP 5.0'),
      ('91000000-0000-4000-8000-000000000018', ${TEST_USER_ID}, 'whoop', 'analysis-separate-main-two',
        '2026-11-22T16:00:00Z', '2026-11-22T21:00:00Z', 300, null,
        false, 'sleep', false, null, 'unknown', 'WHOOP 5.0'),
      ('91000000-0000-4000-8000-000000000019', ${TEST_USER_ID}, 'whoop', 'analysis-chain-first',
        '2026-11-24T06:00:00Z', '2026-11-24T14:00:00Z', 480, null,
        false, 'sleep', false, null, 'unknown', 'WHOOP 5.0'),
      ('91000000-0000-4000-8000-000000000020', ${TEST_USER_ID}, 'apple_health', 'analysis-chain-middle',
        '2026-11-24T06:40:00Z', '2026-11-24T14:40:00Z', 480, null,
        false, 'sleep', false, null, 'unknown', 'Apple Watch'),
      ('91000000-0000-4000-8000-000000000021', ${TEST_USER_ID}, 'dofek', 'analysis-chain-last',
        '2026-11-24T07:20:00Z', '2026-11-24T15:20:00Z', 480, null,
        false, 'sleep', false, null, 'unknown', 'Dofek')`);
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id, anchor_activity_id) VALUES
      ('92000000-0000-4000-8000-000000000001', ${TEST_USER_ID}, '93000000-0000-4000-8000-000000000001'),
      (${lateWorkout}, ${TEST_USER_ID}, '93000000-0000-4000-8000-000000000002'),
      ('92000000-0000-4000-8000-000000000003', ${TEST_USER_ID}, '93000000-0000-4000-8000-000000000003'),
      ('92000000-0000-4000-8000-000000000004', ${TEST_USER_ID}, '93000000-0000-4000-8000-000000000004')`);
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type, started_at, ended_at, local_time_source) VALUES
      ('93000000-0000-4000-8000-000000000001', '92000000-0000-4000-8000-000000000001', ${TEST_USER_ID}, 'whoop',
        'analysis-early-workout', 'cycling', 'cycling', '2026-11-12T02:00:00Z', '2026-11-12T03:00:00Z', 'unknown'),
      ('93000000-0000-4000-8000-000000000002', ${lateWorkout}, ${TEST_USER_ID}, 'whoop',
        'analysis-late-workout', 'running', 'running', '2026-11-19T03:30:00Z', '2026-11-19T04:30:00Z', 'unknown'),
      ('93000000-0000-4000-8000-000000000003', '92000000-0000-4000-8000-000000000003', ${TEST_USER_ID}, 'whoop',
        'analysis-overlapping-workout', 'cycling', 'cycling', '2026-11-19T02:00:00Z', '2026-11-19T04:00:00Z', 'unknown'),
      ('93000000-0000-4000-8000-000000000004', '92000000-0000-4000-8000-000000000004', ${TEST_USER_ID}, 'whoop',
        'analysis-workout-no-end', 'running', 'running', '2026-11-20T03:00:00Z', null, 'unknown')`);
    await context.db.execute(sql`INSERT INTO fitness.food_entry
      (id, user_id, provider_id, external_id, date, nutrition_grain, meal, food_name, started_at) VALUES
      ('94000000-0000-4000-8000-000000000001', ${TEST_USER_ID}, 'dofek', 'analysis-lunch',
        '2026-11-18', 'itemized', 'lunch', 'Lunch fixture', null),
      ('94000000-0000-4000-8000-000000000002', ${TEST_USER_ID}, 'dofek', 'analysis-dinner',
        '2026-11-18', 'itemized', 'dinner', 'Dinner fixture', '2026-11-19T02:00:00Z'),
      ('94000000-0000-4000-8000-000000000003', ${TEST_USER_ID}, 'dofek', 'analysis-second-dinner',
        '2026-11-19', 'itemized', 'dinner', 'Second dinner fixture', null),
      ('94000000-0000-4000-8000-000000000004', ${TEST_USER_ID}, 'dofek', 'analysis-zero-one',
        '2026-11-23', 'itemized', 'snack', 'Zero entry one', null),
      ('94000000-0000-4000-8000-000000000005', ${TEST_USER_ID}, 'dofek', 'analysis-zero-two',
        '2026-11-23', 'itemized', 'snack', 'Zero entry two', null)`);
    await context.db.execute(sql`INSERT INTO fitness.food_entry_nutrient (food_entry_id, nutrient_id, amount) VALUES
      ('94000000-0000-4000-8000-000000000001', 'calories', 800),
      ('94000000-0000-4000-8000-000000000001', 'protein', 50),
      ('94000000-0000-4000-8000-000000000002', 'calories', 900),
      ('94000000-0000-4000-8000-000000000002', 'protein', 60),
      ('94000000-0000-4000-8000-000000000003', 'calories', 800),
      ('94000000-0000-4000-8000-000000000004', 'calories', 0),
      ('94000000-0000-4000-8000-000000000004', 'protein', 0),
      ('94000000-0000-4000-8000-000000000005', 'calories', 0)`);
    const sensorStore = await createClickHouseTestRawSensorStore(context);
    await insertClickHouseMetricStreamRows(context, [
      {
        userId: TEST_USER_ID,
        recordedAt: "2026-11-15T16:00:00Z",
        providerId: "whoop",
        channel: "body_weight",
        scalar: 72,
      },
      {
        userId: TEST_USER_ID,
        recordedAt: "2026-11-18T16:00:00Z",
        providerId: "whoop",
        channel: "body_weight",
        scalar: 70,
      },
    ]);
    server = createDofekMcpServer({
      db: context.db,
      userId: TEST_USER_ID,
      scopes: ["health:read", "activity:read", "nutrition:read"],
      timezone: "UTC",
      sensorStore,
    });
    client = new Client({ name: "relationship-analysis-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await server?.close();
    await context?.cleanup();
  });

  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const response = await client.callTool({ name, arguments: args });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    return z.object({ result: z.unknown() }).parse(response.structuredContent).result;
  }

  async function series(args: Record<string, unknown>) {
    const result = await call("get_recovery_training_series", args);
    return recoveryTrainingSeriesOutputSchema.parse({ result }).result;
  }

  it("reconciles imports before assigning wake dates and honors caller and source timezones", async () => {
    const result = await call("get_sleep_summary", {
      start_date: "2026-11-19",
      end_date: "2026-11-20",
      timezone: zone,
      include_naps: true,
    });
    expect(result).toMatchObject([
      {
        selected_session_id: night,
        started_at: "2026-11-19T06:51:43Z",
        local_start_date: "2026-11-18",
        onset_time: "10:51 PM",
        local_wake_date: "2026-11-19",
        display_timezone: zone,
        timezone_source: "caller",
        is_nap: false,
        source_session_ids: expect.arrayContaining([night, duplicate]),
      },
      { selected_session_id: nap, is_nap: true, local_wake_date: "2026-11-19" },
      {
        local_wake_date: "2026-11-20",
        source_session_ids: expect.arrayContaining([
          "91000000-0000-4000-8000-000000000014",
          "91000000-0000-4000-8000-000000000015",
        ]),
      },
    ]);
    const dst = { start_date: "2026-11-01", end_date: "2026-11-01" };
    expect(await call("get_sleep_summary", { ...dst, timezone: zone })).toMatchObject([
      {
        onset_time: "10:30 PM",
        wake_time: "6:30 AM",
        local_start_date: "2026-10-31",
        timezone_source: "caller",
      },
    ]);
    expect(await call("get_sleep_summary", dst)).toMatchObject([
      {
        onset_time: "1:30 AM",
        wake_time: "9:30 AM",
        display_timezone: "America/New_York",
        timezone_source: "source",
      },
    ]);
  });

  it("compares early and late workouts on the same weekday over 90 days", async () => {
    const result = await series({
      start_date: "2026-08-23",
      end_date: "2026-11-20",
      timezone: zone,
      grain: "main_sleep",
      fields: ["sleep", "activity_exposure"],
      workout_finish_after: "20:00",
    });
    expect(result.rows.find(({ date }) => date === "2026-11-12")).toMatchObject({
      weekday: "Thursday",
      sleep: { local_start_time: "21:30:00", local_wake_time: "07:00:00", duration_minutes: 520 },
      activity_exposure: { last_activity: { local_end_time: "19:00:00" } },
    });
    expect(result.rows.find(({ date }) => date === "2026-11-19")).toMatchObject({
      weekday: "Thursday",
      sleep: { local_start_time: "22:51:43", local_wake_time: "07:00:00", duration_minutes: 448 },
      activity_exposure: {
        last_activity: { id: lateWorkout, canonical_type: "running", local_end_time: "20:30:00" },
        duration: { value_minutes: 150 },
        minutes_to_sleep: 141 + 43 / 60,
      },
    });
    expect(result.rows.find(({ date }) => date === "2026-11-20")?.activity_exposure).toMatchObject({
      coverage_status: "partial",
      duration: { value_minutes: null },
    });
    expect(result.rows[0]?.activity_exposure).toMatchObject({
      coverage_status: "unavailable",
      activity_count: null,
      duration: { value_minutes: null },
    });
    expect(
      result.workout_finish_counts?.find(({ weekday }) => weekday === "Thursday"),
    ).toMatchObject({ before: 1, at_or_after: 1 });
    expect(result.sleep_source_changes).toMatchObject([
      {
        date: "2026-11-18",
        provider: "whoop",
        previous_source_name: "WHOOP 4.0",
        source_name: "WHOOP 5.0",
      },
    ]);
  });

  it("reconciles a chain of pairwise overlaps into one source-prioritized episode", async () => {
    expect(
      await call("get_sleep_summary", {
        start_date: "2026-11-24",
        end_date: "2026-11-24",
        timezone: zone,
      }),
    ).toMatchObject([
      {
        selected_session_id: "91000000-0000-4000-8000-000000000019",
        source_session_ids: [
          "91000000-0000-4000-8000-000000000019",
          "91000000-0000-4000-8000-000000000020",
          "91000000-0000-4000-8000-000000000021",
        ],
      },
    ]);
  });

  it("keeps recorded zero nutrition distinct from incomplete nutrient inputs", async () => {
    expect(
      await call("get_nutrition_summary", {
        start_date: "2026-11-23",
        end_date: "2026-11-23",
      }),
    ).toMatchObject([
      {
        food_entry_count: 2,
        recorded_meal_labels: ["snack"],
        total_calories: 0,
        protein_g: 0,
        missing_nutrient_inputs: ["protein_g", "carbs_g", "fat_g", "fiber_g"],
        first_consumed_at: null,
      },
    ]);
  });

  it("distinguishes no records, a scoped zero, and a missing preceding wake across pages", async () => {
    const noRecords = await series({
      start_date: "2026-11-21",
      end_date: "2026-11-21",
      timezone: zone,
      grain: "main_sleep",
      fields: ["sleep", "activity_exposure"],
    });
    expect(noRecords.rows).toMatchObject([
      {
        sleep: { ended_at: null, local_wake_date: null },
        activity_exposure: {
          coverage_status: "no_records",
          activity_count: 0,
          duration: { value_minutes: null },
        },
      },
    ]);
    const scopedZero = await series({
      start_date: "2026-11-19",
      end_date: "2026-11-19",
      timezone: zone,
      grain: "main_sleep",
      fields: ["activity_exposure"],
      canonical_activity_types: ["strength"],
    });
    expect(scopedZero.rows).toMatchObject([
      {
        activity_exposure: {
          coverage_status: "no_matching_records",
          activity_count: 0,
          duration: { value_minutes: 0 },
        },
      },
    ]);
    const args = {
      start_date: "2026-11-22",
      end_date: "2026-11-22",
      timezone: zone,
      grain: "main_sleep",
      fields: ["sleep", "activity_exposure"],
      limit: 1,
    };
    const first = await series(args);
    expect(first).toMatchObject({
      eligible_count: 2,
      rows: [{ date: "2026-11-22", activity_exposure: { coverage_status: "unavailable" } }],
    });
    expect(first.next_cursor).toBe(first.rows[0]?.row_id);
    const second = await series({ ...args, cursor: first.next_cursor });
    expect(second).toMatchObject({
      eligible_count: 2,
      next_cursor: null,
      rows: [{ date: "2026-11-22", activity_exposure: { coverage_status: "no_records" } }],
    });
    expect(second.rows[0]?.row_id).not.toBe(first.rows[0]?.row_id);
  });

  it("retains provider-specific sleep timing and missing awake values across months", async () => {
    const args = {
      start_date: "2026-09-01",
      end_date: "2026-11-20",
      timezone: zone,
      grain: "main_sleep",
      fields: ["sleep"],
    };
    const whoop = await series({ ...args, providers: ["whoop"] });
    expect(whoop.rows.find(({ date }) => date === "2026-09-03")?.sleep).toMatchObject({
      duration_minutes: 550,
      local_start_time: "22:00:00",
      local_wake_time: "08:00:00",
      stages_minutes: { awake: 50 },
    });
    expect(whoop.rows.find(({ date }) => date === "2026-11-19")?.sleep).toMatchObject({
      selected_session_id: night,
      duration_minutes: 448,
      local_start_time: "22:51:43",
      local_wake_time: "07:00:00",
      stages_minutes: { awake: 40 },
    });
    const apple = await series({ ...args, providers: ["apple_health"] });
    expect(apple.rows.find(({ date }) => date === "2026-11-19")?.sleep).toMatchObject({
      selected_session_id: duplicate,
      duration_minutes: 300,
      stages_minutes: { awake: null },
    });
    expect(apple.observed_counts?.["sleep.awake_minutes"]).toBe(0);
  });

  it("changes meal eligibility and sample sizes beside the weekly weight trend", async () => {
    const args = {
      start_date: "2026-11-18",
      end_date: "2026-11-20",
      timezone: zone,
      fields: ["nutrition", "body_weight"],
    };
    expect(
      await call("get_recovery_training_series", { ...args, required_meals: ["lunch", "dinner"] }),
    ).toMatchObject({
      eligible_count: 1,
      rows: [
        {
          date: "2026-11-18",
          nutrition: {
            food_entry_count: 2,
            recorded_meal_labels: ["dinner", "lunch"],
            timed_food_entry_count: 1,
            first_consumed_at: "2026-11-19T02:00:00.000Z",
            total_calories: 1700,
            protein_g: 110,
            logging_completeness: "unknown_completeness",
          },
          body_weight: { rolling: { average_7d_kg: 71, observed_days_7d: 2 } },
        },
      ],
    });
    const dinner = { ...args, required_meals: ["dinner"], limit: 1 };
    const first = await series(dinner);
    expect(first).toMatchObject({
      eligible_count: 2,
      next_cursor: expect.anything(),
      observed_counts: { "nutrition.total_calories": 2, "nutrition.protein_g": 1 },
    });
    expect(await series({ ...dinner, cursor: first.next_cursor })).toMatchObject({
      rows: [{ date: "2026-11-19", nutrition: { total_calories: 800, protein_g: null } }],
      next_cursor: null,
    });
    expect(
      await call("get_nutrition_summary", { start_date: "2026-11-19", end_date: "2026-11-20" }),
    ).toMatchObject([
      {
        food_entry_count: 1,
        timed_food_entry_count: 0,
        protein_g: null,
        missing_nutrient_inputs: expect.arrayContaining(["protein_g"]),
      },
      { food_entry_count: 0, logging_completeness: "no_logging", total_calories: null },
    ]);
  });

  it("pages more than 25 canonical activities with tied and microsecond start times", async () => {
    await context.db.execute(sql`INSERT INTO fitness.activity_group (id, user_id, anchor_activity_id)
      SELECT ('95000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid, ${TEST_USER_ID},
        ('96000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid
      FROM generate_series(1, 27) number`);
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type,
       started_at, ended_at, timezone, local_time_source, start_utc_offset_minutes, end_utc_offset_minutes)
      SELECT
        ('96000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
        ('95000000-0000-4000-8000-' || lpad(number::text, 12, '0'))::uuid,
        ${TEST_USER_ID}, 'whoop', 'analysis-page-' || number,
        (CASE WHEN number = 1 THEN 'running' ELSE 'cycling' END)::fitness.canonical_activity_type,
        'fixture',
        CASE WHEN number = 1 THEN '2026-12-02T08:30:00.123789Z'::timestamptz
          ELSE '2026-12-02T08:30:00.123456Z'::timestamptz END,
        CASE WHEN number = 27 THEN NULL ELSE '2026-12-02T09:30:00Z'::timestamptz END,
        'America/Los_Angeles',
        CASE WHEN number = 1 THEN 'gps_timezone' ELSE 'home_zone_fallback' END,
        -480, -480
      FROM generate_series(1, 27) number`);
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, group_id, user_id, provider_id, external_id, canonical_type, provider_type,
       started_at, ended_at, local_time_source) VALUES
      ('97000000-0000-4000-8000-000000000001', '95000000-0000-4000-8000-000000000001',
        ${TEST_USER_ID}, 'apple_health', 'analysis-page-copy', 'running', 'fixture',
        '2026-12-02T08:30:00.123789Z', '2026-12-02T09:30:00Z', 'unknown')`);
    const activityServer = createDofekMcpServer({
      db: context.db,
      userId: TEST_USER_ID,
      scopes: ["activity:read"],
      timezone: "UTC",
    });
    const activityClient = new Client({ name: "activity-search-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await activityServer.connect(serverTransport);
    await activityClient.connect(clientTransport);
    async function search(args: Record<string, unknown>) {
      const response = await activityClient.callTool({
        name: "search_activities",
        arguments: { from: "2026-12-02", to: "2026-12-02", limit: 25, ...args },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      return mcpOutputSchemas.searchActivities.parse(response.structuredContent).result;
    }

    try {
      const options = { detail: "compact", timezone: zone };
      const first = await search(options);
      expect(first.totalCount).toBe(27);
      expect(first.items).toHaveLength(25);
      expect(first.items.slice(0, 2)).toMatchObject([
        { id: "95000000-0000-4000-8000-000000000001", canonical_type: "running" },
        { id: "95000000-0000-4000-8000-000000000027", ended_at: null },
      ]);
      expect(Object.keys(first.items[0] ?? {}).sort()).toEqual([
        "canonical_type",
        "ended_at",
        "id",
        "source_providers",
        "started_at",
      ]);
      const second = await search({ ...options, cursor: first.next_cursor });
      expect(second).toMatchObject({
        totalCount: 27,
        next_cursor: null,
        items: [
          { id: "95000000-0000-4000-8000-000000000003" },
          { id: "95000000-0000-4000-8000-000000000002" },
        ],
      });
      expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(27);
      expect(
        await search({ ...options, provider: "apple_health", canonical_type: "running" }),
      ).toMatchObject({ totalCount: 1, items: [{ id: "95000000-0000-4000-8000-000000000001" }] });
      expect(await search({ include: ["mapPreview"], limit: 2 })).toMatchObject({
        next_cursor: "95000000-0000-4000-8000-000000000027",
        items: [{ local_time_source: "gps_timezone" }, { local_time_source: "home_zone_fallback" }],
      });
    } finally {
      await activityClient.close();
      await activityServer.close();
    }
  });
});
