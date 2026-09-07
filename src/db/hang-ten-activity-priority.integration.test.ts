import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

const activityPriorityRowSchema = z.object({
  provider_id: z.string(),
  source_name: z.string().nullable(),
});

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
    const rows = await executeWithSchema(
      testCtx.db,
      activityPriorityRowSchema,
      sql`SELECT provider_id, source_name
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}
            AND member_activity_ids @> ARRAY[
              (SELECT id FROM fitness.activity WHERE external_id = 'hang-ten-priority')
            ]`,
    );

    expect(rows).toEqual([{ provider_id: "apple_health", source_name: "Hang Ten" }]);
  });

  it("restores Hang Ten priority when an older migration was skipped", async () => {
    await testCtx.db.execute(
      sql`DELETE FROM fitness.device_priority
          WHERE provider_id = 'apple_health'
            AND source_name_pattern = 'Hang Ten'`,
    );

    const beforeRepair = await executeWithSchema(
      testCtx.db,
      activityPriorityRowSchema,
      sql`SELECT provider_id, source_name
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}
            AND member_activity_ids @> ARRAY[
              (SELECT id FROM fitness.activity WHERE external_id = 'hang-ten-priority')
            ]`,
    );
    expect(beforeRepair).toEqual([{ provider_id: "whoop", source_name: "WHOOP" }]);

    const migration = readFileSync(
      resolve(import.meta.dirname, "../../drizzle/0097_restore_hang_ten_activity_priority.sql"),
      "utf8",
    );
    await testCtx.db.execute(sql.raw(migration));

    const repaired = await executeWithSchema(
      testCtx.db,
      activityPriorityRowSchema,
      sql`SELECT provider_id, source_name
          FROM fitness.v_activity
          WHERE user_id = ${TEST_USER_ID}
            AND member_activity_ids @> ARRAY[
              (SELECT id FROM fitness.activity WHERE external_id = 'hang-ten-priority')
            ]`,
    );

    expect(repaired).toEqual([{ provider_id: "apple_health", source_name: "Hang Ten" }]);
  });
});
