import type { ClimbingFilters } from "@dofek/training/climbing-filters";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { ClimbingRepository } from "./climbing-repository.ts";

const ATTACHED_ID = "b0000000-0000-4000-8000-000000000001";
const ABSENT_ATTACHED_ID = "b0000000-0000-4000-8000-000000000004";
const UNATTACHED_ID = "b0000000-0000-4000-8000-000000000002";
const ABSENT_ID = "b0000000-0000-4000-8000-000000000003";
const BOUNDARY_ATTACHED_ID = "b0000000-0000-4000-8000-000000000006";
const BOUNDARY_UNATTACHED_ID = "b0000000-0000-4000-8000-000000000007";
const OFFSET_ATTACHED_ID = "b0000000-0000-4000-8000-000000000008";
const activityIdSchema = z.object({ id: z.string(), group_id: z.string() });
const activityStartSchema = activityIdSchema.extend({ started_at: z.string() });
const entryStateSchema = z.object({
  activity_id: z.string().nullable(),
  provider_absent_at: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()),
});

describe("ClimbingRepository PostgreSQL summaries", () => {
  let context: TestContext;
  let activityId: string;
  let activityMemberId: string;

  beforeEach(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES ('climbing-summary-test', 'Climbing Summary Test'),
             ('mountain-project', 'Mountain Project'),
             ('openbeta', 'OpenBeta')
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

    await context.db.execute(sql`INSERT INTO fitness.climbing_entry (id, user_id, provider_id, activity_id, unattached_date, external_id, climb_type, grade_system, grade, result_style, attempt_count, provider_absent_at, raw) VALUES
        (${ATTACHED_ID}, ${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, NULL, 'attached-send', 'boulder', 'v_scale', 'V3', 'Send', 2, NULL, '{}'::jsonb),
        (${ABSENT_ATTACHED_ID}, ${TEST_USER_ID}, 'mountain-project', ${activityMemberId}, NULL, 'absent-attached-send', 'boulder', 'v_scale', 'V8', 'Send', 5, NOW(), '{"retained":true}'::jsonb),
        (${UNATTACHED_ID}, ${TEST_USER_ID}, 'mountain-project', NULL, (SELECT (started_at AT TIME ZONE 'America/Los_Angeles')::date
        FROM fitness.activity WHERE id = ${activityMemberId}::uuid), 'unattached-send', 'boulder', 'v_scale', 'V4', 'Send', 3, NULL, '{}'::jsonb),
        (${ABSENT_ID}, ${TEST_USER_ID}, 'mountain-project', NULL, (SELECT (started_at AT TIME ZONE 'America/Los_Angeles')::date
        FROM fitness.activity WHERE id = ${activityMemberId}::uuid), 'absent-send', 'boulder', 'v_scale', 'V8', 'Send', 5, NOW(), '{}'::jsonb)
`);
  }, 60_000);

  afterEach(async () => {
    await context?.cleanup();
  });

  it("counts matching provider sends once while retaining repeated sends and incomplete attempt coverage", async () => {
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES ('climbing-summary-mirror', 'Climbing mirror')`);
    const [mirror] = await executeWithSchema(
      context.db,
      activityIdSchema,
      sql`
      INSERT INTO fitness.activity (group_id, provider_id, user_id, external_id,
        canonical_type, provider_type, started_at, ended_at, local_time_source)
      SELECT group_id, 'openbeta', user_id, 'mirrored-session', canonical_type,
        provider_type, started_at, ended_at, local_time_source
      FROM fitness.activity WHERE id = ${activityMemberId}::uuid
      RETURNING id::text AS id, group_id::text AS group_id`,
    );
    if (!mirror) throw new Error("Failed to seed mirrored activity");
    await context.db.execute(sql`UPDATE fitness.climbing_entry
      SET route_name = 'Blue Arete',
          location_path = '[{"name":"Gym","externalId":"source-gym","kind":"gym"}]'::jsonb
      WHERE id = ${ATTACHED_ID}::uuid`);
    await context.db.execute(sql`INSERT INTO fitness.climbing_entry
      (user_id, provider_id, activity_id, external_id, climb_type, grade_system,
       grade, result_style, attempt_count, route_name, location_path) VALUES
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'genuine-repeat',
       'boulder', 'v_scale', 'V3', 'Send', 2, 'Blue Arete',
       '[{"name":"Gym","externalId":"source-gym","kind":"gym"}]'::jsonb),
      (${TEST_USER_ID}, 'climbing-summary-mirror', ${mirror.id}, 'mirrored-send',
       'boulder', 'v_scale', 'V3', 'Send', NULL, 'Blue Arete',
       '[{"name":"Gym","externalId":"mirror-gym","kind":"gym"}]'::jsonb)`);

    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "UTC");
    const lanes = (await repository.getGradeProgression(30, { setting: "indoor" })).map((lane) =>
      lane.toDetail(),
    );
    expect(lanes).toMatchObject([
      {
        style: "boulder",
        periods: [
          {
            settings: [
              {
                climbingDays: 1,
                sends: 2,
                sendsPerDay: 2,
                segments: [{ grade: "V3", sends: 2 }],
              },
            ],
          },
        ],
      },
    ]);
    expect(
      (await repository.getVolumeByGrade(30, { setting: "indoor" })).map((row) => row.toDetail()),
    ).toMatchObject([{ grade: "V3", sends: 2, attempts: 4, recordedAttempts: 4 }]);
    expect(
      (await repository.getSessionSummaries(30, { setting: "indoor" })).map((row) =>
        row.toDetail(),
      ),
    ).toMatchObject([{ activityId, sends: 2, attempts: 4 }]);

    await context.db.execute(sql`UPDATE fitness.climbing_entry SET attempt_count = 4
      WHERE external_id = 'mirrored-send' AND user_id = ${TEST_USER_ID}::uuid`);
    expect(
      (await repository.getVolumeByGrade(30, { setting: "indoor" })).map((row) => row.toDetail()),
    ).toMatchObject([{ grade: "V3", sends: 2, attempts: null, recordedAttempts: 2 }]);
  });

  it("keeps unnamed climbs and distinct style, setting, and angle contexts separate across providers", async () => {
    await context.db.execute(sql`INSERT INTO fitness.provider (id, name)
      VALUES ('climbing-summary-mirror', 'Climbing mirror')`);
    const [mirror] = await executeWithSchema(
      context.db,
      activityIdSchema,
      sql`
      INSERT INTO fitness.activity (group_id, provider_id, user_id, external_id,
        canonical_type, provider_type, started_at, ended_at, local_time_source)
      SELECT group_id, 'climbing-summary-mirror', user_id, 'mirrored-session', canonical_type,
        provider_type, started_at, ended_at, local_time_source
      FROM fitness.activity WHERE id = ${activityMemberId}::uuid
      RETURNING id::text AS id, group_id::text AS group_id`,
    );
    if (!mirror) throw new Error("Failed to seed mirrored activity");
    await context.db.execute(sql`INSERT INTO fitness.climbing_entry
      (user_id, provider_id, activity_id, external_id, climb_type, grade_system, grade,
       climb_style, result_style, wall_angle, route_name, location_path) VALUES
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'follow-a',
       'route', 'yds', '5.9', 'follow', 'Send', '{"value":20,"unit":"degrees"}'::jsonb,
       'Arete', '[{"name":"Gym","externalId":null,"kind":"gym"}]'::jsonb),
      (${TEST_USER_ID}, 'climbing-summary-mirror', ${mirror.id}, 'follow-b',
       'route', 'yds', '5.9', 'follow', 'Send', '{"value":20,"unit":null}'::jsonb,
       'Arete', '[{"name":"Gym","externalId":null,"kind":"gym"}]'::jsonb),
      (${TEST_USER_ID}, 'climbing-summary-mirror', ${mirror.id}, 'follow-outdoor',
       'route', 'yds', '5.9', 'follow', 'Send', '{"value":20,"unit":"degrees"}'::jsonb,
       'Arete', '[{"name":"Gym","externalId":null,"kind":"destination"}]'::jsonb),
      (${TEST_USER_ID}, 'climbing-summary-mirror', ${mirror.id}, 'solo-b',
       'route', 'yds', '5.9', 'solo', 'Send', '{"value":20,"unit":"degrees"}'::jsonb,
       'Arete', '[{"name":"Gym","externalId":null,"kind":"gym"}]'::jsonb),
      (${TEST_USER_ID}, 'climbing-summary-mirror', ${mirror.id}, 'unnamed',
       'boulder', 'v_scale', 'V3', NULL, 'Send', NULL, NULL, '[]'::jsonb)`);
    const lanes = (
      await new ClimbingRepository(context.db, TEST_USER_ID, "UTC").getGradeProgression(30)
    ).map((lane) => lane.toDetail());
    expect(lanes.find((lane) => lane.style === "boulder")?.periods[0]?.settings).toMatchObject([
      { setting: "outdoor", sends: 1 },
      { setting: "unknown", sends: 2 },
    ]);
    expect(lanes.find((lane) => lane.style === "follow")?.periods[0]?.settings).toMatchObject([
      { setting: "indoor", sends: 2 },
      { setting: "outdoor", sends: 1 },
    ]);
    expect(lanes.find((lane) => lane.style === "solo")?.periods[0]?.settings).toMatchObject([
      { setting: "indoor", sends: 1 },
    ]);
  });

  it("separates grade stacks by style and setting and retains failed-only recorded days", async () => {
    await context.db.execute(sql`UPDATE fitness.climbing_entry
      SET location_path = '[{"name":"Gym","externalId":null,"kind":"gym"}]'::jsonb
      WHERE id = ${ATTACHED_ID}::uuid`);
    await context.db.execute(sql`INSERT INTO fitness.climbing_attempt
      (climbing_entry_id, attempt_index, outcome, failure_reason)
      VALUES (${ATTACHED_ID}::uuid, 1, 'failed', 'fell')`);
    await context.db.execute(sql`INSERT INTO fitness.climbing_entry
      (user_id, provider_id, activity_id, external_id, climb_type, grade_system, grade,
       climb_style, result_style, location_path) VALUES
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'lane-lead-1',
       'route', 'yds', '5.10a', 'lead', 'Send', '[{"name":"Gym","externalId":null,"kind":"gym"}]'::jsonb),
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'lane-lead-2',
       'route', 'yds', '5.10a', 'lead', 'Send', '[{"name":"Gym","externalId":null,"kind":"gym"}]'::jsonb),
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'lane-top-rope',
       'route', 'yds', '5.11a', 'top-rope', 'Send', '[{"name":"Gym","externalId":null,"kind":"gym"}]'::jsonb)`);

    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    const lanes = (await repository.getGradeProgression(30)).map((row) => row.toDetail());
    expect(lanes).toMatchObject([
      {
        style: "boulder",
        settings: ["indoor", "outdoor"],
        periods: [
          {
            settings: [
              { setting: "indoor", climbingDays: 1, sends: 0, sendsPerDay: 0 },
              { setting: "outdoor", climbingDays: 1, sends: 1, sendsPerDay: 1 },
            ],
          },
        ],
      },
      {
        style: "top-rope",
        periods: [
          {
            settings: [
              {
                climbingDays: 1,
                sends: 1,
                segments: [{ grade: "5.11a", sends: 1 }],
              },
            ],
          },
        ],
      },
      {
        style: "lead",
        periods: [
          {
            settings: [
              {
                climbingDays: 1,
                sends: 2,
                segments: [{ grade: "5.10a", sends: 2, sendsPerDay: 2 }],
              },
            ],
          },
        ],
      },
    ]);
    const focused = (
      await repository.getGradeProgression(30, { style: "lead", setting: "indoor" })
    ).map((row) => row.toDetail());
    expect(focused).toMatchObject([
      {
        style: "lead",
        settings: ["indoor"],
        periods: [
          {
            settings: [
              {
                climbingDays: 1,
                sends: 2,
                sendsPerDay: 2,
              },
            ],
          },
        ],
      },
    ]);
  });

  it("applies independent style, protection, and setting selections to actual database entries", async () => {
    await context.db.execute(sql`UPDATE fitness.climbing_entry
      SET climb_type = 'route', grade_system = 'yds', grade = '5.9',
          climb_style = 'lead', route_protection = ARRAY['sport'],
          location_path = '[{"name":"Gym","externalId":null,"kind":"gym"}]'::jsonb
      WHERE id = ${ATTACHED_ID}::uuid`);
    await context.db.execute(sql`INSERT INTO fitness.climbing_entry
      (user_id, provider_id, unattached_date, external_id, climb_type, grade_system, grade,
       result_style, attempt_count, route_protection, raw)
      VALUES (${TEST_USER_ID}, 'climbing-summary-test', CURRENT_DATE - 2, 'unknown-method-route',
              'route', 'yds', '5.10a', 'Send', 1, ARRAY['trad'], '{}'::jsonb)`);
    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    const cases: Array<{ filters: ClimbingFilters; grades: string[] }> = [
      { filters: {}, grades: ["5.9", "5.10a", "V4"] },
      { filters: { style: "boulder" }, grades: ["V4"] },
      { filters: { style: "route" }, grades: ["5.9", "5.10a"] },
      { filters: { style: "unknown" }, grades: ["5.10a"] },
      { filters: { style: "lead" }, grades: ["5.9"] },
      { filters: { style: "top-rope" }, grades: [] },
      { filters: { protection: "unknown" }, grades: ["V4"] },
      { filters: { protection: "sport" }, grades: ["5.9"] },
      { filters: { protection: "trad" }, grades: ["5.10a"] },
      { filters: { setting: "indoor" }, grades: ["5.9"] },
      { filters: { setting: "outdoor" }, grades: ["V4"] },
      { filters: { setting: "unknown" }, grades: ["5.10a"] },
      { filters: { style: "lead", protection: "sport", setting: "indoor" }, grades: ["5.9"] },
      { filters: { style: "route", protection: "trad", setting: "outdoor" }, grades: [] },
    ];
    for (const { filters, grades } of cases) {
      const rows = await repository.getVolumeByGrade(30, filters);
      expect(rows.map((row) => row.toDetail().grade).sort(), JSON.stringify(filters)).toEqual(
        grades.toSorted(),
      );
    }
  });

  it.each(["mountain-project", "openbeta"])(
    "treats existing %s entries without location metadata as outdoor in every summary",
    async (providerId) => {
      await context.db.execute(sql`UPDATE fitness.climbing_entry
        SET provider_id = ${providerId}, location_path = '[]'::jsonb
        WHERE id IN (${ATTACHED_ID}::uuid, ${UNATTACHED_ID}::uuid)`);
      const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
      expect(
        (await repository.getVolumeByGrade(30, { setting: "outdoor" })).map((row) =>
          row.toDetail(),
        ),
      ).toEqual([
        expect.objectContaining({ grade: "V3", attempts: 2, sends: 1 }),
        expect.objectContaining({ grade: "V4", attempts: 3, sends: 1 }),
      ]);
      expect(
        (await repository.getGradeProgression(30, { setting: "outdoor" })).map((row) =>
          row.toDetail(),
        ),
      ).toEqual([
        expect.objectContaining({
          grades: [
            expect.objectContaining({ grade: "V3" }),
            expect.objectContaining({ grade: "V4" }),
          ],
          periods: [
            expect.objectContaining({
              settings: [expect.objectContaining({ climbingDays: 1, sends: 2, sendsPerDay: 2 })],
            }),
          ],
        }),
      ]);
      expect(
        (await repository.getSessionSummaries(30, { setting: "outdoor" })).map((row) =>
          row.toDetail(),
        ),
      ).toEqual([expect.objectContaining({ attempts: 2, sends: 1 })]);
      for (const setting of ["indoor", "unknown"] as const) {
        expect(await repository.getVolumeByGrade(30, { setting })).toEqual([]);
        expect(await repository.getGradeProgression(30, { setting })).toEqual([]);
        expect(await repository.getSessionSummaries(30, { setting })).toEqual([]);
      }
    },
  );

  it("filters attached and unattached climbs before computing metrics, retaining unknown settings", async () => {
    await context.db.execute(sql`UPDATE fitness.climbing_entry
      SET climb_type = 'route', grade_system = 'yds', grade = CASE WHEN id = ${ATTACHED_ID}::uuid THEN '5.9' ELSE '5.10a' END,
          climb_style = 'lead', route_protection = ARRAY['sport', 'trad'],
          location_path = '[{"name":"Crag","externalId":null,"kind":"destination"}]'::jsonb
      WHERE id IN (${ATTACHED_ID}::uuid, ${UNATTACHED_ID}::uuid)`);
    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    const filters = { style: "lead", protection: "trad", setting: "outdoor" } as const;
    expect((await repository.getVolumeByGrade(30, filters)).map((row) => row.toDetail())).toEqual([
      expect.objectContaining({ grade: "5.9", attempts: 2, sends: 1 }),
      expect.objectContaining({ grade: "5.10a", attempts: 3, sends: 1 }),
    ]);
    expect(await repository.getGradeProgression(30, { protection: "unknown" })).toEqual([]);
    expect((await repository.getSessionSummaries(30, filters))[0]?.toDetail()).toMatchObject({
      attempts: 2,
    });
    expect(await repository.getSessionSummaries(30, { style: "top-rope" })).toEqual([]);
    await context.db.execute(sql`UPDATE fitness.climbing_entry SET location_path = '[]'::jsonb
      WHERE id = ${ATTACHED_ID}::uuid`);
    expect(
      (await repository.getVolumeByGrade(30, { setting: "unknown" })).map((row) => row.toDetail()),
    ).toEqual([expect.objectContaining({ grade: "5.9" })]);
    expect((await repository.getVolumeByGrade(30, filters)).map((row) => row.toDetail())).toEqual([
      expect.objectContaining({ grade: "5.10a" }),
    ]);
  });

  it("serves a full source context independently of the associated activity provider", async () => {
    const locationPath = ["Country", "State", "Region", "Park", "Crag", "Wall"].map(
      (name, index) => ({ name, externalId: `area-${index}`, kind: null }),
    );
    await context.db.execute(sql`UPDATE fitness.climbing_entry
      SET provider_id = 'mountain-project', location_path = ${JSON.stringify(locationPath)}::jsonb,
          climb_style = 'top-rope', result_style = 'Frenchfree', attempt_count = NULL,
          wall_angle = '{"value":-20,"unit":null}'::jsonb
      WHERE id = ${ATTACHED_ID}::uuid`);
    const [detail] = await new ClimbingRepository(
      context.db,
      TEST_USER_ID,
      "UTC",
    ).getActivityEntries(activityId);
    expect(detail?.toDetail()).toMatchObject({
      sent: null,
      attemptCount: null,
      lead: false,
      wallAngleDegrees: null,
      context: {
        providerId: "mountain-project",
        locationPath,
        board: null,
        wallAngle: { value: -20, unit: null },
        climbStyle: "top-rope",
        resultStyle: "Frenchfree",
      },
    });
  });

  it("excludes absent attached ticks from active reads and restores them when the provider returns", async () => {
    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");

    const progression = await repository.getGradeProgression(30);
    expect(progression.map((row) => row.toDetail())).toEqual([
      expect.objectContaining({
        climbType: "boulder",
        grades: [
          expect.objectContaining({ grade: "V3" }),
          expect.objectContaining({ grade: "V4" }),
        ],
      }),
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
      expect.objectContaining({
        climbType: "boulder",
        grades: expect.arrayContaining([expect.objectContaining({ grade: "V8" })]),
      }),
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

  it("uses the same strict calendar-day boundary for attached and unattached entries", async () => {
    const timezone = "America/Los_Angeles";
    const boundaryDate = sql`(NOW() AT TIME ZONE ${timezone})::date - 30`;
    const [boundaryActivity] = await executeWithSchema(
      context.db,
      activityIdSchema,
      sql`INSERT INTO fitness.activity (
        provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, local_time_source, timezone
      ) VALUES (
        'climbing-summary-test', ${TEST_USER_ID}, 'summary-boundary', 'climbing', 'climbing',
        (((NOW() AT TIME ZONE ${timezone})::date - 30)::timestamp + INTERVAL '12 hours') AT TIME ZONE ${timezone},
        (((NOW() AT TIME ZONE ${timezone})::date - 30)::timestamp + INTERVAL '13 hours') AT TIME ZONE ${timezone},
        'unknown', NULL
      ) RETURNING id::text AS id, group_id::text AS group_id`,
    );
    if (!boundaryActivity) throw new Error("Failed to seed boundary climbing activity");
    await context.db.execute(sql`INSERT INTO fitness.climbing_entry (id, user_id, provider_id, activity_id, unattached_date, external_id, climb_type, grade_system, grade, result_style, attempt_count, provider_absent_at, raw) VALUES
        (${BOUNDARY_ATTACHED_ID}, ${TEST_USER_ID}, 'climbing-summary-test', ${boundaryActivity.id}, NULL, 'boundary-attached', 'boulder', 'v_scale', 'V6', 'Send', 1, NULL, '{}'::jsonb),
        (${BOUNDARY_UNATTACHED_ID}, ${TEST_USER_ID}, 'mountain-project', NULL, ${boundaryDate}, 'boundary-unattached', 'boulder', 'v_scale', 'V7', 'Send', 1, NULL, '{}'::jsonb)
`);

    const repository = new ClimbingRepository(context.db, TEST_USER_ID, timezone);
    expect(
      (await repository.getGradeProgression(30)).flatMap((row) =>
        row.toDetail().grades.map(({ grade }) => grade),
      ),
    ).not.toEqual(expect.arrayContaining(["V6", "V7"]));
    expect((await repository.getVolumeByGrade(30)).map((row) => row.toDetail().grade)).not.toEqual(
      expect.arrayContaining(["V6", "V7"]),
    );
  });

  it("uses the source-resolved activity date in climbing summaries", async () => {
    const [offsetActivity] = await executeWithSchema(
      context.db,
      activityStartSchema,
      sql`INSERT INTO fitness.activity (
        provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, local_time_source, start_utc_offset_minutes,
        end_utc_offset_minutes, timezone
      ) VALUES (
        'climbing-summary-test', ${TEST_USER_ID}, 'summary-offset-date', 'climbing', 'climbing',
        (date_trunc('month', NOW() AT TIME ZONE 'UTC') + INTERVAL '1 hour') AT TIME ZONE 'UTC',
        (date_trunc('month', NOW() AT TIME ZONE 'UTC') + INTERVAL '2 hours') AT TIME ZONE 'UTC',
        'provider_offset', 120, 120, NULL
      ) RETURNING id::text AS id, group_id::text AS group_id, started_at::text AS started_at`,
    );
    if (!offsetActivity) throw new Error("Failed to seed source-offset climbing activity");
    const expectedDate = new Date(Date.parse(offsetActivity.started_at) + 120 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    await context.db.execute(sql`INSERT INTO fitness.climbing_entry (id, user_id, provider_id, activity_id, external_id, climb_type, grade_system, grade, result_style, attempt_count, raw) VALUES
        (${OFFSET_ATTACHED_ID}, ${TEST_USER_ID}, 'climbing-summary-test', ${offsetActivity.id}, 'summary-offset-entry', 'boulder', 'v_scale', 'V9', 'Send', 1, '{}'::jsonb)
`);

    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    expect((await repository.getGradeProgression(90)).map((row) => row.toDetail())).toContainEqual(
      expect.objectContaining({
        periods: expect.arrayContaining([
          expect.objectContaining({
            startDate: `${expectedDate.slice(0, 7)}-01`,
            settings: expect.arrayContaining([
              expect.objectContaining({
                segments: expect.arrayContaining([
                  expect.objectContaining({ grade: "V9", sends: 1 }),
                ]),
              }),
            ]),
          }),
        ]),
      }),
    );
    expect((await repository.getSessionSummaries(90)).map((row) => row.toDetail())).toContainEqual(
      expect.objectContaining({ activityId: offsetActivity.group_id, date: expectedDate }),
    );
  });

  it("retains known sends and unsuccessful climbs when attempt counts are unknown", async () => {
    await context.db.execute(sql`DELETE FROM fitness.activity
      WHERE user_id = ${TEST_USER_ID} AND provider_id = 'climbing-summary-test' AND external_id = 'unknown-count-session'`);
    const [activity] = await executeWithSchema(
      context.db,
      activityIdSchema,
      sql`
      INSERT INTO fitness.activity (
        provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, local_time_source
      ) VALUES (
        'climbing-summary-test', ${TEST_USER_ID}, 'unknown-count-session', 'climbing', 'climbing',
        NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day' + INTERVAL '1 hour', 'unknown'
      ) RETURNING id::text AS id, group_id::text AS group_id`,
    );
    if (!activity) throw new Error("Failed to seed unknown-count climbing activity");
    await context.db.execute(sql`INSERT INTO fitness.climbing_entry (user_id, provider_id, activity_id, external_id, climb_type, grade_system, grade, result_style, attempt_count) VALUES
        (${TEST_USER_ID}, 'climbing-summary-test', ${activity.id}, 'unknown-count-send', 'boulder', 'v_scale', 'V5', 'Send', NULL),
        (${TEST_USER_ID}, 'climbing-summary-test', ${activity.id}, 'unknown-count-attempt', 'boulder', 'v_scale', 'V5', 'Not sent', NULL),
        (${TEST_USER_ID}, 'climbing-summary-test', ${activity.id}, 'known-count-attempt', 'boulder', 'font', '6C', 'Not sent', 3),
        (${TEST_USER_ID}, 'climbing-summary-test', ${activity.id}, 'unknown-outcome', 'route', 'yds', '5.12a', NULL, 2)
`);

    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    expect(
      (await repository.getActivityEntries(activity.group_id)).map((entry) => entry.toDetail()),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sent: true, attemptCount: null, grade: "V5" }),
        expect.objectContaining({ sent: false, attemptCount: null, grade: "V5" }),
        expect.objectContaining({ sent: null, attemptCount: 2, climbType: "route" }),
      ]),
    );
    expect((await repository.getVolumeByGrade(30)).map((entry) => entry.toDetail())).toContainEqual(
      expect.objectContaining({ grade: "V5", attempts: null, sends: 1 }),
    );
    expect(
      (await repository.getSessionSummaries(30)).map((entry) => entry.toDetail()),
    ).toContainEqual(
      expect.objectContaining({
        activityId: activity.group_id,
        attempts: null,
        sends: 1,
        hardestBoulderGrade: "V5",
      }),
    );
    expect(
      (await repository.getGradeProgression(30)).map((entry) => entry.toDetail()),
    ).toContainEqual(
      expect.objectContaining({
        grades: expect.arrayContaining([expect.objectContaining({ grade: "V5" })]),
      }),
    );
  });

  it("returns recorded attempt subtotals independently of complete totals and combines converted grades", async () => {
    await context.db.execute(sql`INSERT INTO fitness.climbing_entry
      (user_id, provider_id, activity_id, external_id, climb_type, grade_system, grade, result_style, attempt_count) VALUES
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'mixed-known', 'boulder', 'v_scale', 'V5', 'Not sent', 4),
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'mixed-unknown', 'boulder', 'v_scale', 'V5', 'Send', NULL),
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'mixed-converted', 'boulder', 'font', '6C', 'Not sent', 3),
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'all-unknown', 'boulder', 'v_scale', 'V6', 'Send', NULL),
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'all-unknown-converted', 'boulder', 'font', '7A', 'Not sent', NULL),
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'all-known', 'boulder', 'v_scale', 'V7', 'Send', 2),
      (${TEST_USER_ID}, 'climbing-summary-test', ${activityMemberId}, 'all-known-converted', 'boulder', 'font', '7A+', 'Not sent', 3)`);

    const repository = new ClimbingRepository(context.db, TEST_USER_ID, "America/Los_Angeles");
    expect((await repository.getVolumeByGrade(30)).map((row) => row.toDetail())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ grade: "V5", attempts: null, recordedAttempts: 7 }),
        expect.objectContaining({ grade: "V6", attempts: null, recordedAttempts: null }),
        expect.objectContaining({ grade: "V7", attempts: 5, recordedAttempts: 5 }),
      ]),
    );
  });
});
