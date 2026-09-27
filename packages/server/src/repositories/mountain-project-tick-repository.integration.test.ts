import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { ActivityRepository } from "./activity-repository.ts";
import { MountainProjectTickRepository } from "./mountain-project-tick-repository.ts";

const OTHER_USER_ID = "a0000000-0000-4000-8000-000000000001";
const DATE_MATCH_TICK_ID = "a0000000-0000-4000-8000-000000000002";
const ADJACENT_TICK_ID = "a0000000-0000-4000-8000-000000000003";
const ABSENT_TICK_ID = "a0000000-0000-4000-8000-000000000004";
const FOREIGN_TICK_ID = "a0000000-0000-4000-8000-000000000005";
const activityIdRowSchema = z.object({ id: z.string(), group_id: z.string() });
const groupIdRowSchema = z.object({ group_id: z.string() });
const attachedTickRowSchema = z.object({
  activity_id: z.string(),
  unattached_date: z.string().nullable(),
});

describe("MountainProjectTickRepository PostgreSQL behavior", () => {
  let context: TestContext;
  let activityId: string;
  let groupId: string;
  let memberId: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${OTHER_USER_ID}, 'Mountain Project Tick Other User')`);
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES ('mountain-project', 'Mountain Project'), ('tick_activity_provider', 'Tick Activity')
      ON CONFLICT (id) DO NOTHING`);
    const inserted = await executeWithSchema(
      context.db,
      activityIdRowSchema,
      sql`INSERT INTO fitness.activity (
      provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, local_time_source, timezone
    ) VALUES (
      'tick_activity_provider', ${TEST_USER_ID}, 'tick-local-day-activity', 'climbing', 'climbing',
      '2026-01-02T00:30:00Z', '2026-01-02T02:00:00Z', 'unknown', NULL
    ) RETURNING id::text AS id, group_id::text AS group_id`,
    );
    const [activity] = inserted;
    if (!activity) throw new Error("Failed to seed Mountain Project target activity");
    memberId = activity.id;
    groupId = activity.group_id;
    activityId = groupId;

    await context.db.execute(sql`INSERT INTO fitness.climbing_entry (
      id, user_id, provider_id, activity_id, unattached_date, external_id,
      climb_type, grade_system, grade, sent, attempt_count, provider_absent_at, raw
    ) VALUES
      (${DATE_MATCH_TICK_ID}, ${TEST_USER_ID}, 'mountain-project', NULL, '2026-01-01',
       'local-day', 'boulder', 'v_scale', 'V4', TRUE, 1, NULL, '{"exported":true}'::jsonb),
      (${ADJACENT_TICK_ID}, ${TEST_USER_ID}, 'mountain-project', NULL, '2026-01-02',
       'adjacent-day', 'boulder', 'v_scale', 'V5', TRUE, 1, NULL, '{}'::jsonb),
      (${ABSENT_TICK_ID}, ${TEST_USER_ID}, 'mountain-project', NULL, '2026-01-01',
       'absent', 'boulder', 'v_scale', 'V6', TRUE, 1, CURRENT_TIMESTAMP, '{}'::jsonb),
      (${FOREIGN_TICK_ID}, ${OTHER_USER_ID}, 'mountain-project', NULL, '2026-01-01',
       'foreign-user', 'boulder', 'v_scale', 'V7', TRUE, 1, NULL, '{}'::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("returns only active unattached owned Mountain Project ticks on the exact displayed local day", async () => {
    const repo = new MountainProjectTickRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    expect(await repo.getSuggestions(activityId)).toEqual([
      expect.objectContaining({ id: DATE_MATCH_TICK_ID, grade: "V4", locationName: null }),
    ]);
  });

  it("attaches one same-day tick to the actual member row resolved from the canonical group", async () => {
    const activity = await new ActivityRepository(
      context.db,
      TEST_USER_ID,
      "America/Los_Angeles",
    ).findById(activityId);
    expect(activity?.id).toBe(groupId);
    const repo = new MountainProjectTickRepository(context.db, TEST_USER_ID, "America/Los_Angeles");

    await repo.attachTick({ tickId: DATE_MATCH_TICK_ID, activityId });

    const rows = await executeWithSchema(
      context.db,
      attachedTickRowSchema,
      sql`SELECT activity_id::text AS activity_id, unattached_date::text AS unattached_date
      FROM fitness.climbing_entry WHERE id = ${DATE_MATCH_TICK_ID}::uuid`,
    );
    expect(rows).toEqual([{ activity_id: memberId, unattached_date: null }]);
    await expect(repo.attachTick({ tickId: DATE_MATCH_TICK_ID, activityId })).rejects.toMatchObject(
      {
        code: "CONFLICT",
      },
    );
  });

  it("rejects adjacent-day, foreign-user, and non-climbing targets", async () => {
    const repo = new MountainProjectTickRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    await expect(repo.attachTick({ tickId: ADJACENT_TICK_ID, activityId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(repo.getSuggestions("ffffffff-ffff-4fff-8fff-ffffffffffff")).rejects.toMatchObject(
      {
        code: "NOT_FOUND",
      },
    );

    const otherActivity = await executeWithSchema(
      context.db,
      groupIdRowSchema,
      sql`INSERT INTO fitness.activity (
      provider_id, user_id, external_id, canonical_type, provider_type, started_at
    ) VALUES ('tick_activity_provider', ${TEST_USER_ID}, 'tick-wrong-type', 'running', 'running',
      '2026-01-02T00:30:00Z') RETURNING group_id::text AS group_id`,
    );
    const [{ group_id: otherActivityId }] = otherActivity;
    await expect(
      repo.attachTick({ tickId: ADJACENT_TICK_ID, activityId: otherActivityId }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(repo.getSuggestions(otherActivityId)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });
});
