import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { backfillClimbingAttemptCount } from "./climbing-attempt-count-backfill.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const attemptCountRowSchema = z.array(z.object({ attempt_count: z.number() }));

describe("backfillClimbingAttemptCount integration", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('kaya-export', 'Kaya', ${TEST_USER_ID})
      ON CONFLICT DO NOTHING
    `);
    await testContext.db.execute(sql`
      WITH inserted_activity AS (
        INSERT INTO fitness.activity (
          provider_id, user_id, external_id, canonical_type, provider_type, started_at
        ) VALUES (
          'kaya-export', ${TEST_USER_ID}, 'climbing-attempt-backfill', 'climbing', 'rock_climbing', NOW()
        )
        RETURNING id
      )
      INSERT INTO fitness.climbing_entry (
        activity_id, external_id, climb_type, grade_system, grade, sent, source_name, raw
      )
      SELECT
        id, 'climbing-attempt-backfill-entry', 'boulder', 'v_scale', 'V3', true, 'Kaya',
        '{"attempts": 4}'::jsonb
      FROM inserted_activity
    `);
  });

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("backfills Kaya raw attempt counts in an idempotent way after a dry run", async () => {
    await expect(backfillClimbingAttemptCount(testContext.db, false)).resolves.toBe(1);

    const beforeRows = attemptCountRowSchema.parse(
      await testContext.db.execute(sql`
        SELECT attempt_count
        FROM fitness.climbing_entry
        WHERE external_id = 'climbing-attempt-backfill-entry'
      `),
    );
    expect(beforeRows[0]?.attempt_count).toBe(1);

    await expect(backfillClimbingAttemptCount(testContext.db, true)).resolves.toBe(1);
    await expect(backfillClimbingAttemptCount(testContext.db, true)).resolves.toBe(0);

    const afterRows = attemptCountRowSchema.parse(
      await testContext.db.execute(sql`
        SELECT attempt_count
        FROM fitness.climbing_entry
        WHERE external_id = 'climbing-attempt-backfill-entry'
      `),
    );
    expect(afterRows[0]?.attempt_count).toBe(4);
  });
});
