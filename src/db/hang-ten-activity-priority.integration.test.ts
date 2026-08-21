import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("Hang Ten activity priority", () => {
  let testCtx: TestContext;

  beforeAll(async () => {
    testCtx = await setupTestDatabase();

    await testCtx.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES
            ('apple_health', 'Apple Health', ${TEST_USER_ID}),
            ('whoop', 'WHOOP', ${TEST_USER_ID})
          ON CONFLICT DO NOTHING`,
    );

    await testCtx.db.execute(
      sql`INSERT INTO fitness.activity (
            provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, source_name
          ) VALUES
            (
              'apple_health', ${TEST_USER_ID}, 'hang-ten-priority', 'hangboard', 'Hang Ten',
              TIMESTAMPTZ '2026-08-20 10:00:00+00',
              TIMESTAMPTZ '2026-08-20 11:00:00+00', 'Hang Ten'
            ),
            (
              'whoop', ${TEST_USER_ID}, 'whoop-hangboard-priority', 'hangboard', 'Strength',
              TIMESTAMPTZ '2026-08-20 10:00:00+00',
              TIMESTAMPTZ '2026-08-20 11:00:00+00', 'WHOOP'
            )`,
    );
  });

  afterAll(async () => {
    await testCtx?.cleanup();
  });

  it("selects Hang Ten over an overlapping WHOOP activity", async () => {
    const rows = await testCtx.db.execute<{ provider_id: string; source_name: string | null }>(
      sql`SELECT provider_id, source_name
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}
            AND member_activity_ids @> ARRAY[
              (SELECT id FROM fitness.activity WHERE external_id = 'hang-ten-priority')
            ]`,
    );

    expect(rows).toEqual([{ provider_id: "apple_health", source_name: "Hang Ten" }]);
  });
});
