import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

const activityIds = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
  "00000000-0000-4000-8000-000000000203",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectPlanStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectPlanStrings);
  }

  if (isRecord(value)) {
    return Object.values(value).flatMap(collectPlanStrings);
  }

  return typeof value === "string" ? [value] : [];
}

function hasBidirectionalOverlapGuards(planText: string): boolean {
  const directions: Array<{ endAlias: string; startAlias: string }> = [];
  const comparisonPattern =
    /\b([a-zA-Z_]\w*)\.(started_at|ended_at)\s*([<>])\s*([a-zA-Z_]\w*)\.(started_at|ended_at)\b/g;

  for (const match of planText.matchAll(comparisonPattern)) {
    const leftAlias = match[1];
    const leftColumn = match[2];
    const operator = match[3];
    const rightAlias = match[4];
    const rightColumn = match[5];
    if (!(leftAlias && rightAlias) || leftAlias === rightAlias) continue;

    if (leftColumn === "started_at" && operator === "<" && rightColumn === "ended_at") {
      directions.push({ startAlias: leftAlias, endAlias: rightAlias });
    } else if (leftColumn === "ended_at" && operator === ">" && rightColumn === "started_at") {
      directions.push({ startAlias: rightAlias, endAlias: leftAlias });
    }
  }

  return directions.some(({ startAlias, endAlias }) =>
    directions.some(
      (candidate) => candidate.startAlias === endAlias && candidate.endAlias === startAlias,
    ),
  );
}

describe("activity overlap query plan", () => {
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

  it("requires positive overlap for candidate pairs", async () => {
    if (!testCtx) {
      throw new Error("Test database setup did not complete");
    }

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

    const explainRows = await executeWithSchema(
      testCtx.db,
      z.object({ "QUERY PLAN": z.unknown() }),
      sql`EXPLAIN (FORMAT JSON)
          SELECT count(*)
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}`,
    );
    const planText = collectPlanStrings(explainRows[0]?.["QUERY PLAN"]).join(" ");

    expect(hasBidirectionalOverlapGuards(planText)).toBe(true);
  });
});
