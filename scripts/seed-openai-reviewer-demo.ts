import { pathToFileURL } from "node:url";
import { createTaggedQueryClient, type TaggedQueryClient } from "../src/db/tagged-query-client.ts";

export const REVIEWER_EMAIL = "asherlc+openai-review@asherlc.com";
export const OPENAI_REVIEWER_DEMO_SOURCE = "OpenAI Reviewer Demo (synthetic)";

const providerNames = {
  apple_health: "Apple Health",
  strava: "Strava",
  whoop: "WHOOP",
} as const;

const dailyMetrics = [
  ["2026-08-18", 58, 7420],
  ["2026-08-19", 61, 8150],
  ["2026-08-20", 59, 6900],
  ["2026-08-21", 63, 10120],
  ["2026-08-22", 65, 11340],
  ["2026-08-23", 62, 8840],
  ["2026-08-24", 60, 7750],
  ["2026-08-25", 64, 9520],
  ["2026-08-26", 66, 10680],
  ["2026-08-27", 63, 9180],
  ["2026-08-28", 67, 11240],
  ["2026-08-29", 65, 9880],
  ["2026-08-30", 68, 12060],
  ["2026-08-31", 66, 10940],
] as const;

const sleepDates = [
  "2026-08-25",
  "2026-08-26",
  "2026-08-27",
  "2026-08-28",
  "2026-08-29",
  "2026-08-30",
  "2026-08-31",
] as const;
const activities = [
  ["2026-08-19", "cycling", "Synthetic Endurance Ride", "17:10"],
  ["2026-08-22", "running", "Synthetic Steady Run", "16:42"],
  ["2026-08-26", "walking", "Synthetic Recovery Walk", "16:35"],
  ["2026-08-30", "cycling", "Synthetic Tempo Ride", "16:58"],
] as const;

export async function seedOpenAiReviewerDemo(sql: TaggedQueryClient): Promise<void> {
  const reviewers = await sql<{ id: string }[]>`
    SELECT id FROM fitness.user_profile WHERE email = ${REVIEWER_EMAIL}
  `;
  const reviewer = reviewers[0];
  if (!reviewer || reviewers.length !== 1) {
    throw new Error(`Synthetic OpenAI reviewer account ${REVIEWER_EMAIL} must exist exactly once`);
  }
  const userId = reviewer.id;

  for (const [providerId, name] of Object.entries(providerNames)) {
    await sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES (${providerId}, ${name}, NULL)
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `;
    await sql`
      INSERT INTO fitness.provider_connection (user_id, provider_id)
      VALUES (${userId}, ${providerId})
      ON CONFLICT (user_id, provider_id) DO NOTHING
    `;
  }

  await sql`DELETE FROM fitness.daily_metrics WHERE user_id = ${userId} AND source_name = ${OPENAI_REVIEWER_DEMO_SOURCE}`;
  await sql`DELETE FROM fitness.sleep_session WHERE user_id = ${userId} AND source_name = ${OPENAI_REVIEWER_DEMO_SOURCE}`;
  await sql`DELETE FROM fitness.activity WHERE user_id = ${userId} AND source_name = ${OPENAI_REVIEWER_DEMO_SOURCE}`;
  await sql`DELETE FROM fitness.sync_log WHERE user_id = ${userId} AND data_type = 'openai_reviewer_demo'`;

  for (const [date, hrv, steps] of dailyMetrics) {
    await sql`
      INSERT INTO fitness.daily_metrics (date, provider_id, user_id, hrv, steps, source_name)
      VALUES (${date}, 'whoop', ${userId}, ${hrv}, ${steps}, ${OPENAI_REVIEWER_DEMO_SOURCE})
    `;
  }
  for (const date of sleepDates) {
    await sql`
      INSERT INTO fitness.sleep_session (
        provider_id, user_id, external_id, started_at, ended_at, duration_minutes,
        deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct,
        staging_available, sleep_type, source_name, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
      ) VALUES (
        'whoop', ${userId}, ${`openai-reviewer-demo-sleep-${date}`},
        ${`${date}T05:30:00.000Z`}, ${`${date}T13:00:00.000Z`}, 420,
        78, 102, 210, 30, 92.9, true, 'sleep', ${OPENAI_REVIEWER_DEMO_SOURCE},
        'America/Los_Angeles', -420, -420, 'provider_timezone'
      )
    `;
  }
  for (const [date, canonicalType, name, endedAt] of activities) {
    await sql`
      INSERT INTO fitness.activity (
        provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at,
        name, perceived_exertion, source_name, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
      ) VALUES (
        'strava', ${userId}, ${`openai-reviewer-demo-activity-${date}`}, ${canonicalType},
        ${canonicalType}, ${`${date}T16:00:00.000Z`}, ${`${date}T${endedAt}:00.000Z`},
        ${name}, 5, ${OPENAI_REVIEWER_DEMO_SOURCE}, 'America/Los_Angeles',
        -420, -420, 'provider_timezone'
      )
    `;
  }
  for (const [providerId, syncedAt] of [
    ["whoop", "2026-08-31T17:00:00.000Z"],
    ["apple_health", "2026-08-31T17:15:00.000Z"],
    ["strava", "2026-08-31T16:45:00.000Z"],
  ] as const) {
    await sql`
      INSERT INTO fitness.sync_log (provider_id, user_id, data_type, status, record_count, synced_at)
      VALUES (${providerId}, ${userId}, 'openai_reviewer_demo', 'success', 1, ${syncedAt})
    `;
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL environment variable is required");
  const sql = createTaggedQueryClient(databaseUrl);
  try {
    await seedOpenAiReviewerDemo(sql);
    console.log(
      "Seeded synthetic OpenAI reviewer demo: 14 daily metrics, 7 sleep records, 4 activities, 3 provider syncs",
    );
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
