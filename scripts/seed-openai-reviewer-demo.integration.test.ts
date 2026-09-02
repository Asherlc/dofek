import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTaggedQueryClient,
  type TaggedQueryClient,
} from "../src/db/tagged-query-client.ts";
import { setupTestDatabase, type TestContext } from "../src/db/test-helpers.ts";
import {
  OPENAI_REVIEWER_DEMO_SOURCE,
  REVIEWER_EMAIL,
  seedOpenAiReviewerDemo,
} from "./seed-openai-reviewer-demo.ts";

const reviewerId = "10000000-0000-4000-8000-000000000001";
const controlUserId = "20000000-0000-4000-8000-000000000001";

describe("OpenAI reviewer demo seed", () => {
  let context: TestContext;
  let sql: TaggedQueryClient;

  beforeAll(async () => {
    context = await setupTestDatabase();
    sql = createTaggedQueryClient(context.connectionString);
    await sql`
      INSERT INTO fitness.user_profile (id, name, email)
      VALUES
        (${reviewerId}, 'OpenAI Reviewer', ${REVIEWER_EMAIL}),
        (${controlUserId}, 'Control User', 'control@example.test')
    `;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await context?.cleanup();
  });

  it("creates only deterministic synthetic reviewer records for the requested demo ranges", async () => {
    await seedOpenAiReviewerDemo(sql);
    await seedOpenAiReviewerDemo(sql);

    expect(
      await sql`
        SELECT date::text AS date, hrv, steps
        FROM fitness.daily_metrics
        WHERE user_id = ${reviewerId}
          AND source_name = ${OPENAI_REVIEWER_DEMO_SOURCE}
        ORDER BY date
      `,
    ).toEqual([
      { date: "2026-08-18", hrv: 58, steps: 7420 },
      { date: "2026-08-19", hrv: 61, steps: 8150 },
      { date: "2026-08-20", hrv: 59, steps: 6900 },
      { date: "2026-08-21", hrv: 63, steps: 10120 },
      { date: "2026-08-22", hrv: 65, steps: 11340 },
      { date: "2026-08-23", hrv: 62, steps: 8840 },
      { date: "2026-08-24", hrv: 60, steps: 7750 },
      { date: "2026-08-25", hrv: 64, steps: 9520 },
      { date: "2026-08-26", hrv: 66, steps: 10680 },
      { date: "2026-08-27", hrv: 63, steps: 9180 },
      { date: "2026-08-28", hrv: 67, steps: 11240 },
      { date: "2026-08-29", hrv: 65, steps: 9880 },
      { date: "2026-08-30", hrv: 68, steps: 12060 },
      { date: "2026-08-31", hrv: 66, steps: 10940 },
    ]);
    expect(
      await sql`
        SELECT DATE(started_at)::text AS date
        FROM fitness.sleep_session
        WHERE user_id = ${reviewerId}
          AND source_name = ${OPENAI_REVIEWER_DEMO_SOURCE}
        ORDER BY started_at
      `,
    ).toEqual([
      { date: "2026-08-25" },
      { date: "2026-08-26" },
      { date: "2026-08-27" },
      { date: "2026-08-28" },
      { date: "2026-08-29" },
      { date: "2026-08-30" },
      { date: "2026-08-31" },
    ]);
    expect(
      await sql`
        SELECT external_id
        FROM fitness.activity
        WHERE user_id = ${reviewerId}
          AND source_name = ${OPENAI_REVIEWER_DEMO_SOURCE}
        ORDER BY started_at
      `,
    ).toEqual([
      { external_id: "openai-reviewer-demo-activity-2026-08-19" },
      { external_id: "openai-reviewer-demo-activity-2026-08-22" },
      { external_id: "openai-reviewer-demo-activity-2026-08-26" },
      { external_id: "openai-reviewer-demo-activity-2026-08-30" },
    ]);
    expect(
      await sql`
        SELECT provider_id, synced_at
        FROM fitness.sync_log
        WHERE user_id = ${reviewerId}
          AND data_type = 'openai_reviewer_demo'
        ORDER BY provider_id
      `,
    ).toEqual([
      { provider_id: "apple_health", synced_at: new Date("2026-08-31T17:15:00.000Z") },
      { provider_id: "strava", synced_at: new Date("2026-08-31T16:45:00.000Z") },
      { provider_id: "whoop", synced_at: new Date("2026-08-31T17:00:00.000Z") },
    ]);
    expect(
      await sql`
        SELECT provider_id
        FROM fitness.provider_connection
        WHERE user_id = ${reviewerId}
        ORDER BY provider_id
      `,
    ).toEqual([
      { provider_id: "apple_health" },
      { provider_id: "strava" },
      { provider_id: "whoop" },
    ]);
    expect(
      await sql`
        SELECT count(*)::int AS count
        FROM fitness.daily_metrics
        WHERE user_id = ${controlUserId}
      `,
    ).toEqual([{ count: 0 }]);
  });
});
