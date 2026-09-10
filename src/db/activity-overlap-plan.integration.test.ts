import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { reconcileActivityGroups } from "./activity-group-reconciliation.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

const activityIds = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
  "00000000-0000-4000-8000-000000000203",
] as const;

describe("persisted activity overlap groups", () => {
  let testCtx: TestContext | undefined;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    await executeWithSchema(
      testCtx.db,
      z.object({}),
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('wahoo', 'Wahoo', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await executeWithSchema(
      testCtx.db,
      z.object({}),
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at
          ) VALUES
          (
            ${activityIds[0]}::uuid, 'wahoo', ${TEST_USER_ID}, 'overlap-plan-a', 'cycling', 'cycling',
            TIMESTAMPTZ '2026-01-10 10:00:00+00',
            TIMESTAMPTZ '2026-01-10 11:00:00+00'
          ),
          (
            ${activityIds[1]}::uuid, 'wahoo', ${TEST_USER_ID}, 'overlap-plan-contained', 'cycling', 'cycling',
            TIMESTAMPTZ '2026-01-10 10:05:00+00',
            TIMESTAMPTZ '2026-01-10 10:55:00+00'
          ),
          (
            ${activityIds[2]}::uuid, 'wahoo', ${TEST_USER_ID}, 'overlap-plan-touching', 'cycling', 'cycling',
            TIMESTAMPTZ '2026-01-10 11:00:00+00',
            TIMESTAMPTZ '2026-01-10 12:00:00+00'
          )`,
    );
  });

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  it("projects persisted membership until reconciliation applies changed overlap", async () => {
    if (!testCtx) {
      throw new Error("Test database setup did not complete");
    }

    await testCtx.db.transaction((transaction) =>
      reconcileActivityGroups(transaction, TEST_USER_ID),
    );
    // A source correction does not silently redefine identity while reading the view.
    await testCtx.db.execute(sql`UPDATE fitness.activity
      SET started_at = started_at + INTERVAL '1 day', ended_at = ended_at + INTERVAL '1 day'
      WHERE id = ${activityIds[1]}::uuid`);

    const rows = await executeWithSchema(
      testCtx.db,
      z.object({ member_activity_ids: z.array(z.string()) }),
      sql`SELECT member_activity_ids::text[] AS member_activity_ids
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}
            AND member_activity_ids && ARRAY[
              ${activityIds[0]}::uuid,
              ${activityIds[1]}::uuid,
              ${activityIds[2]}::uuid
            ]
          ORDER BY started_at`,
    );

    expect(
      rows.map((row) => row.member_activity_ids.length).sort((left, right) => left - right),
    ).toEqual([1, 2]);

    await testCtx.db.transaction((transaction) =>
      reconcileActivityGroups(transaction, TEST_USER_ID),
    );
    const reconciled = await executeWithSchema(
      testCtx.db,
      z.object({ member_activity_ids: z.array(z.string()) }),
      sql`SELECT member_activity_ids::text[] FROM fitness.v_activity WHERE user_id = ${TEST_USER_ID}`,
    );
    expect(reconciled.map((row) => row.member_activity_ids.length)).toEqual([1, 1, 1]);
  });
});
