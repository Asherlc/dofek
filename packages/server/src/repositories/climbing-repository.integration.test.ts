import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { ClimbingRepository } from "./climbing-repository.ts";

const ATTACHED_ID = "b0000000-0000-4000-8000-000000000001";
const ABSENT_ATTACHED_ID = "b0000000-0000-4000-8000-000000000004";
const UNATTACHED_ID = "b0000000-0000-4000-8000-000000000002";
const ABSENT_ID = "b0000000-0000-4000-8000-000000000003";
const activityIdSchema = z.object({ id: z.string(), group_id: z.string() });
const entryStateSchema = z.object({
  activity_id: z.string().nullable(),
  provider_absent_at: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()),
});

describe("ClimbingRepository PostgreSQL summaries", () => {
  let context: TestContext;
  let activityId: string;
  let activityMemberId: string;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES ('climbing-summary-test', 'Climbing Summary Test'),
             ('mountain-project', 'Mountain Project')
      ON CONFLICT (id) DO NOTHING`);
    const activities = await executeWithSchema(
      context.db,
      activityIdSchema,
      sql`INSERT INTO fitness.activity (
      provider_id, user_id, external_id, canonical_type, provider_type,
      started_at, ended_at, local_time_source, timezone
    ) VALUES (
      'climbing-summary-test', ${TEST_USER_ID}, 'summary-session', 'climbing', 'climbing',
      NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days' + INTERVAL '1 hour', 'unknown', NULL
    ) RETURNING id::text AS id, group_id::text AS group_id`,
    );
    const [seededActivity] = activities;
    if (!seededActivity) throw new Error("Failed to seed climbing activity");
    activityId = seededActivity.group_id;
    activityMemberId = seededActivity.id;

    await context.db.execute(sql`INSERT INTO fitness.climbing_entry (
      id, user_id, provider_id, activity_id, unattached_date, external_id,
      climb_type, grade_system, grade, sent, attempt_count, provider_absent_at, raw
    ) VALUES
      (${ATTACHED_ID}, ${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, NULL,
       'attached-send', 'boulder', 'v_scale', 'V3', TRUE, 2, NULL, '{}'::jsonb),
      (${ABSENT_ATTACHED_ID}, ${TEST_USER_ID}, 'mountain-project', ${activityMemberId}, NULL,
       'absent-attached-send', 'boulder', 'v_scale', 'V8', TRUE, 5, NOW(), '{"retained":true}'::jsonb),
      (${UNATTACHED_ID}, ${TEST_USER_ID}, 'mountain-project', NULL,
       (SELECT (started_at AT TIME ZONE 'America/Los_Angeles')::date
        FROM fitness.activity WHERE id = ${activityMemberId}::uuid),
       'unattached-send', 'boulder', 'v_scale', 'V4', TRUE, 3, NULL, '{}'::jsonb),
      (${ABSENT_ID}, ${TEST_USER_ID}, 'mountain-project', NULL,
       (SELECT (started_at AT TIME ZONE 'America/Los_Angeles')::date
        FROM fitness.activity WHERE id = ${activityMemberId}::uuid),
       'absent-send', 'boulder', 'v_scale', 'V8', TRUE, 5, NOW(), '{}'::jsonb)`);
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("excludes absent attached ticks from active reads and restores them when the provider returns", async () => {
    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");

    const progression = await repository.getGradeProgression(30);
    expect(progression.map((row) => row.toDetail())).toEqual([
      expect.objectContaining({ climbType: "boulder", grade: "V4" }),
    ]);

    const volume = await repository.getVolumeByGrade(30);
    expect(volume.map((row) => row.toDetail())).toEqual([
      expect.objectContaining({ climbType: "boulder", grade: "V3", attempts: 2, sends: 1 }),
      expect.objectContaining({ climbType: "boulder", grade: "V4", attempts: 3, sends: 1 }),
    ]);

    const sessions = await repository.getSessionSummaries(30);
    expect(sessions.map((row) => row.toDetail())).toHaveLength(1);
    expect(sessions[0]?.toDetail()).toMatchObject({ attempts: 2, sends: 1 });
    const details = await repository.getActivityEntries(activityId);
    expect(details.map((row) => row.toDetail().id)).toEqual([ATTACHED_ID]);

    const retainedRows = await executeWithSchema(
      context.db,
      entryStateSchema,
      sql`SELECT activity_id::text AS activity_id, provider_absent_at::text AS provider_absent_at, raw
          FROM fitness.climbing_entry WHERE id = ${ABSENT_ATTACHED_ID}::uuid`,
    );
    expect(retainedRows).toEqual([
      expect.objectContaining({
        activity_id: activityMemberId,
        provider_absent_at: expect.any(String),
        raw: { retained: true },
      }),
    ]);

    await context.db.execute(sql`UPDATE fitness.climbing_entry
      SET provider_absent_at = NULL WHERE id = ${ABSENT_ATTACHED_ID}::uuid`);

    expect((await repository.getGradeProgression(30)).map((row) => row.toDetail())).toEqual([
      expect.objectContaining({ climbType: "boulder", grade: "V8" }),
    ]);
    expect((await repository.getVolumeByGrade(30)).map((row) => row.toDetail())).toEqual([
      expect.objectContaining({ grade: "V3", attempts: 2, sends: 1 }),
      expect.objectContaining({ grade: "V4", attempts: 3, sends: 1 }),
      expect.objectContaining({ grade: "V8", attempts: 5, sends: 1 }),
    ]);
    expect((await repository.getSessionSummaries(30))[0]?.toDetail()).toMatchObject({
      attempts: 7,
      sends: 2,
    });
    expect(
      (await repository.getActivityEntries(activityId)).map((row) => row.toDetail().id),
    ).toEqual([ABSENT_ATTACHED_ID, ATTACHED_ID]);
  });
});
