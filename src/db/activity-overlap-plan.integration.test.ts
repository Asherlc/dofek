import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

const activityIds = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
  "00000000-0000-4000-8000-000000000203",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findPairsPlan(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value) && value["Subplan Name"] === "CTE pairs") {
    return value;
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findPairsPlan(child);
      if (match) return match;
    }
  } else if (isRecord(value)) {
    for (const child of Object.values(value)) {
      const match = findPairsPlan(child);
      if (match) return match;
    }
  }

  return undefined;
}

describe("activity overlap query plan", () => {
  let testCtx: TestContext;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();
    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('wahoo', 'Wahoo', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );
    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, external_id, activity_type, started_at, ended_at
          ) VALUES
          (
            ${activityIds[0]}::uuid, 'wahoo', ${TEST_USER_ID}, 'overlap-plan-a', 'cycling',
            TIMESTAMPTZ '2026-01-10 10:00:00+00',
            TIMESTAMPTZ '2026-01-10 11:00:00+00'
          ),
          (
            ${activityIds[1]}::uuid, 'wahoo', ${TEST_USER_ID}, 'overlap-plan-contained', 'cycling',
            TIMESTAMPTZ '2026-01-10 10:05:00+00',
            TIMESTAMPTZ '2026-01-10 10:55:00+00'
          ),
          (
            ${activityIds[2]}::uuid, 'wahoo', ${TEST_USER_ID}, 'overlap-plan-touching', 'cycling',
            TIMESTAMPTZ '2026-01-10 11:00:00+00',
            TIMESTAMPTZ '2026-01-10 12:00:00+00'
          )`,
    );
  });

  afterAll(async () => {
    await testCtx.cleanup();
  });

  it("requires positive overlap for candidate pairs", async () => {
    const rows = await testCtx.db.execute<{ member_activity_ids: string[] }>(
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

    expect(rows.map((row) => row.member_activity_ids.length).sort()).toEqual([1, 2]);

    const explainRows = await testCtx.db.execute<{ "QUERY PLAN": unknown }>(
      sql`EXPLAIN (FORMAT JSON)
          SELECT count(*)
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}`,
    );
    const pairsPlan = findPairsPlan(explainRows[0]?.["QUERY PLAN"]);
    const joinFilter = pairsPlan?.["Join Filter"];

    expect(joinFilter).toEqual(expect.any(String));
    expect(joinFilter).toContain("(c1.started_at < c2.ended_at)");
    expect(joinFilter).toContain("(c2.started_at < c1.ended_at)");
  });
});
