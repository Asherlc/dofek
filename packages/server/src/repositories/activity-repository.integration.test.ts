import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { ActivityRepository } from "./activity-repository.ts";

describe("ActivityRepository perceived exertion", () => {
  let testContext: TestContext;
  let repository: ActivityRepository;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    repository = new ActivityRepository(testContext.db, TEST_USER_ID);

    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES
            ('effort-primary', 'Effort Primary', ${TEST_USER_ID}),
            ('effort-fallback', 'Effort Fallback', ${TEST_USER_ID}),
            ('effort-device', 'Effort Device', ${TEST_USER_ID})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider_priority (provider_id, priority)
          VALUES
            ('effort-primary', 0),
            ('effort-fallback', 2),
            ('effort-device', 100)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.device_priority (provider_id, source_name_pattern, priority)
          VALUES ('effort-device', 'Preferred effort device', 1)`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity (
            id, provider_id, user_id, activity_type, started_at, ended_at, source_name,
            perceived_exertion
          ) VALUES
            (
              '00000000-0000-4000-8000-000000000081', 'effort-primary', ${TEST_USER_ID},
              'running', TIMESTAMPTZ '2026-08-18 10:00:00+00',
              TIMESTAMPTZ '2026-08-18 10:30:00+00', 'Primary effort device', NULL
            ),
            (
              '00000000-0000-4000-8000-000000000082', 'effort-fallback', ${TEST_USER_ID},
              'running', TIMESTAMPTZ '2026-08-18 10:00:05+00',
              TIMESTAMPTZ '2026-08-18 10:30:05+00', 'Fallback effort device', 6
            ),
            (
              '00000000-0000-4000-8000-000000000083', 'effort-device', ${TEST_USER_ID},
              'running', TIMESTAMPTZ '2026-08-18 10:00:10+00',
              TIMESTAMPTZ '2026-08-18 10:30:10+00', 'Preferred effort device', 8
            )`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("selects the highest-priority non-null effort across deduplicated activities", async () => {
    const groupedActivities = await executeWithSchema(
      testContext.db,
      z.object({ member_activity_ids: z.array(z.string()) }),
      sql`SELECT member_activity_ids::text[] AS member_activity_ids
          FROM fitness.v_activity
          WHERE '00000000-0000-4000-8000-000000000081'::uuid = ANY(member_activity_ids)`,
    );
    expect(groupedActivities[0]?.member_activity_ids).toHaveLength(3);

    const activity = await repository.findById("00000000-0000-4000-8000-000000000081");

    expect(activity?.perceived_exertion).toBe(8);
  });
});
