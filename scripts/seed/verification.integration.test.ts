import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTaggedQueryClient,
  type TaggedQueryClient,
} from "../../src/db/tagged-query-client.ts";
import { setupTestDatabase, type TestContext } from "../../src/db/test-helpers.ts";
import { USER_ID } from "./helpers.ts";
import { verifySeed } from "./verification.ts";

let testContext: TestContext;
let sql: TaggedQueryClient;

beforeAll(async () => {
  testContext = await setupTestDatabase();
  sql = createTaggedQueryClient(testContext.connectionString);

  await insertVerificationPrerequisites();
}, 120_000);

beforeEach(async () => {
  await sql`DELETE FROM fitness.food_entry WHERE user_id = ${USER_ID}`;
});

afterAll(async () => {
  await sql?.end();
  await testContext?.cleanup();
});

describe("review seed verification", () => {
  it("rejects many food rows on fewer than 85 canonical dates", async () => {
    await insertFoodEntries({ distinctDates: 84, totalEntries: 85 });

    const dateCounts = await sql`
      SELECT
        COUNT(DISTINCT date)::int AS canonical_date_count,
        COUNT(DISTINCT logged_at::date)::int AS logged_at_date_count,
        COUNT(*)::int AS total_entry_count
      FROM fitness.food_entry
      WHERE user_id = ${USER_ID}
    `;
    expect(dateCounts).toEqual([
      {
        canonical_date_count: 84,
        logged_at_date_count: 85,
        total_entry_count: 85,
      },
    ]);

    await expect(verifySeed(sql)).rejects.toThrow(
      "Seed verification failed for nutrition days: expected at least 85, got 84",
    );
  });

  it("accepts exactly 85 nutrition dates and still reports total food entries", async () => {
    await insertFoodEntries({ distinctDates: 85, totalEntries: 85 });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(verifySeed(sql)).resolves.toBeUndefined();
      expect(logSpy).toHaveBeenCalledWith("  nutrition days: 85");
      expect(logSpy).toHaveBeenCalledWith("  food entries: 85");
    } finally {
      logSpy.mockRestore();
    }
  });
});

async function insertFoodEntries({
  distinctDates,
  totalEntries,
}: {
  distinctDates: number;
  totalEntries: number;
}): Promise<void> {
  for (let entryIndex = 0; entryIndex < totalEntries; entryIndex++) {
    const dateIndex = entryIndex < distinctDates ? entryIndex : 0;
    const date = dateForIndex(dateIndex);
    const loggedAt =
      entryIndex === 0
        ? "2026-01-01T23:30:00.000Z"
        : entryIndex === distinctDates
          ? "2026-01-02T08:30:00.000Z"
          : `${date}T12:00:00.000Z`;

    await sql`
      INSERT INTO fitness.food_entry (
        provider_id,
        user_id,
        external_id,
        date,
        food_name,
        logged_at,
        confirmed
      ) VALUES (
        'manual_review',
        ${USER_ID},
        ${`review-verification-${entryIndex}`},
        ${date},
        'Review verification fixture',
        ${loggedAt},
        true
      )
    `;
  }
}

function dateForIndex(dateIndex: number): string {
  const date = new Date(Date.UTC(2026, 0, 2 + dateIndex));
  return date.toISOString().slice(0, 10);
}

async function insertVerificationPrerequisites(): Promise<void> {
  await sql`
    INSERT INTO fitness.user_profile (id, name)
    VALUES (${USER_ID}, 'Review verification fixture')
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name
    `;
  await sql`
    INSERT INTO fitness.provider (id, name, user_id)
    VALUES
      ('manual_review', 'Manual review', ${USER_ID}),
      ('verification-2', 'Verification 2', ${USER_ID}),
      ('verification-3', 'Verification 3', ${USER_ID}),
      ('verification-4', 'Verification 4', ${USER_ID}),
      ('verification-5', 'Verification 5', ${USER_ID})
    ON CONFLICT (id) DO UPDATE
      SET name = EXCLUDED.name,
          user_id = EXCLUDED.user_id
  `;
  await sql`
    INSERT INTO fitness.provider_connection (user_id, provider_id)
    SELECT ${USER_ID}, id
    FROM fitness.provider
    WHERE id IN (
      'manual_review',
      'verification-2',
      'verification-3',
      'verification-4',
      'verification-5'
    )
    ON CONFLICT (user_id, provider_id) DO NOTHING
  `;

  await sql`
    INSERT INTO fitness.daily_metrics (date, provider_id, user_id)
    SELECT
      DATE '2026-01-01' + generated_index,
      'manual_review',
      ${USER_ID}
    FROM generate_series(1, 170) AS generated_index
  `;

  await sql`
    INSERT INTO fitness.sleep_session (
      provider_id,
      user_id,
      external_id,
      started_at
    )
    SELECT
      'manual_review',
      ${USER_ID},
      'verification-sleep-' || generated_index,
      TIMESTAMPTZ '2026-01-01T00:00:00Z' + generated_index * INTERVAL '1 day'
    FROM generate_series(1, 100) AS generated_index
  `;

  await sql`
    INSERT INTO fitness.activity (
      provider_id,
      user_id,
      external_id,
      canonical_type,
      provider_type,
      started_at
    )
    SELECT
      'manual_review',
      ${USER_ID},
      'verification-activity-' || generated_index,
      'walking',
      'walking',
      TIMESTAMPTZ '2026-01-01T00:00:00Z' + generated_index * INTERVAL '1 day'
    FROM generate_series(1, 90) AS generated_index
  `;

  await sql`
    INSERT INTO fitness.clinical_record (
      user_id,
      provider_id,
      external_id,
      clinical_type,
      display_name,
      fhir_version,
      fhir,
      downloaded_at,
      recorded_at
    )
    SELECT
      ${USER_ID},
      'manual_review',
      'verification-lab-' || generated_index,
      'labResult',
      'Verification lab result',
      'R4',
      jsonb_build_object('resourceType', 'Observation', 'id', 'verification-lab-' || generated_index),
      TIMESTAMPTZ '2026-01-01T00:00:00Z' + generated_index * INTERVAL '1 day',
      TIMESTAMPTZ '2026-01-01T00:00:00Z' + generated_index * INTERVAL '1 day'
    FROM generate_series(1, 8) AS generated_index
  `;

  await sql`
    INSERT INTO fitness.journal_question (
      slug,
      display_name,
      category,
      data_type
    )
    VALUES (
      'verification-question',
      'Verification question',
      'verification',
      'boolean'
    )
  `;

  await sql`
    INSERT INTO fitness.journal_entry (
      date,
      provider_id,
      user_id,
      question_slug,
      answer_text
    )
    SELECT
      DATE '2026-01-01' + generated_index,
      'manual_review',
      ${USER_ID},
      'verification-question',
      'yes'
    FROM generate_series(1, 30) AS generated_index
  `;
}
