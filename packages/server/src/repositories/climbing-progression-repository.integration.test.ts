import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { persistClimbingLogEntries } from "../../../../src/db/climbing-log-sync.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ClimbingProgressionRepository } from "./climbing-progression-repository.ts";

describe("ClimbingProgressionRepository database semantics", () => {
  const userId = randomUUID();
  const kayaProvider = `climb-kaya-${randomUUID()}`;
  const mirrorProvider = `climb-mirror-${randomUUID()}`;
  const kayaActivity = randomUUID();
  const mirrorActivity = randomUUID();
  const offsetActivity = randomUUID();
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Climbing progression fixture')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        (${kayaProvider}, 'Kaya fixture', ${userId}::uuid),
        (${mirrorProvider}, 'Mirror fixture', ${userId}::uuid)
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, raw, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
      ) VALUES
        (${kayaActivity}::uuid, ${kayaActivity}::uuid, ${kayaProvider}, ${userId}::uuid, 'kaya-session',
          'climbing', 'bouldering', '2026-07-10T18:00:00Z', '2026-07-10T20:00:00Z',
          'Pacific Pipe', 'Kaya', '{}'::jsonb, NULL, NULL, NULL, 'unknown'),
        (${mirrorActivity}::uuid, ${kayaActivity}::uuid, ${mirrorProvider}, ${userId}::uuid, 'mirror-session',
          'climbing', 'bouldering', '2026-07-10T18:00:00Z', '2026-07-10T20:00:00Z',
          'Pacific Pipe mirror', 'Mirror', '{}'::jsonb, NULL, NULL, NULL, 'unknown'),
        (${offsetActivity}::uuid, ${offsetActivity}::uuid, ${kayaProvider}, ${userId}::uuid, 'offset-session',
          'climbing', 'bouldering', '2026-07-12T00:30:00Z', '2026-07-12T01:30:00Z',
          'Travel climbing', 'Kaya', '{}'::jsonb, NULL, -420, -420, 'provider_offset')
    `);
    for (const [providerId, activityId, externalId, value, name, angle, count, qualifier] of [
      [kayaProvider, kayaActivity, "kaya-blue", "V5", "Blue Arete", 30, 3, "free-send"],
      [mirrorProvider, mirrorActivity, "mirror-blue", "V5", "Blue Arete", 30, 3, "free-send"],
      [kayaProvider, kayaActivity, "kaya-red", "V6", "Red Roof", 20, 1, null],
      [kayaProvider, offsetActivity, "offset-green", "V3", "Green Slab", 10, 1, "free-flash"],
    ] as const)
      await persistClimbingLogEntries(context.db, {
        userId,
        providerId,
        entries: [
          {
            externalId,
            activityId,
            discipline: "rock_climbing",
            sourceName: providerId === kayaProvider ? "Kaya" : "Mirror",
            wallAngle: { value: angle, unit: "degrees" },
            climb: {
              externalId: value,
              kind: "boulder",
              name,
              publishedGrades: [{ value, system: "v_scale" }],
              areas: [
                {
                  externalId: activityId === offsetActivity ? "travel" : "gym",
                  name: activityId === offsetActivity ? "Travel Gym" : "Pacific Pipe",
                },
              ],
            },
            attempts: [{ scope: "climb", ...(qualifier === null ? {} : { qualifier }) }],
            reportedAttemptCounts: [{ scope: "climb", count }],
          },
        ],
      });
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("deduplicates the canonical session and exact mirrored entry without inventing missing attempts", async () => {
    const result = await new ClimbingProgressionRepository(
      context.db,
      userId,
      "America/Los_Angeles",
    ).listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      filters: {},
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result.coverage).toMatchObject({
      sessions: 1,
      entries: 2,
      entries_with_attempts: 2,
      attempt_data: "complete",
      merged_exact_duplicate_records: 1,
    });
    expect(result.daily).toEqual([
      expect.objectContaining({
        attempts: 4,
        attempts_status: "complete",
        entries: 2,
        sessions: 1,
      }),
    ]);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.member_activity_ids).toEqual(
      expect.arrayContaining([kayaActivity, mirrorActivity]),
    );
    expect(result.sessions[0]?.timezone).toMatchObject({
      assumed: true,
      local_time_source: "unknown",
    });
    expect(result.sessions[0]?.climbing_log_entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recorded_attempt_count: 1,
          climb_name: "Red Roof",
          sends: 0,
          unknown_outcomes: 1,
        }),
        expect.objectContaining({
          recorded_attempt_count: 3,
          provenance: expect.objectContaining({
            merged_duplicate: true,
            source_providers: expect.arrayContaining([kayaProvider, mirrorProvider]),
          }),
          climb_name: "Blue Arete",
        }),
      ]),
    );
  });

  it("uses an authoritative offset-only local date and returns the full time context", async () => {
    const result = await new ClimbingProgressionRepository(
      context.db,
      userId,
      "Europe/Helsinki",
    ).listRange({
      startDate: "2026-07-11",
      endDate: "2026-07-11",
      providers: [],
      filters: {},
      locations: ["Travel Gym"],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result.sessions).toEqual([
      expect.objectContaining({
        activity_id: offsetActivity,
        date: "2026-07-11",
        timezone: {
          analysis_timezone: "Europe/Helsinki",
          assumed: false,
          end_utc_offset_minutes: -420,
          local_time_source: "provider_offset",
          start_utc_offset_minutes: -420,
          value: null,
        },
      }),
    ]);
    expect(result.sessions[0]?.climbing_log_entries).toEqual([
      expect.objectContaining({ rock_result_labels: expect.objectContaining({ flash: true }) }),
    ]);
  });

  it("serves zero degrees while leaving an unverified angle out of degree analytics", async () => {
    const activityId = randomUUID();
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, raw, local_time_source
      ) VALUES (
        ${activityId}::uuid, ${activityId}::uuid, ${kayaProvider}, ${userId}::uuid,
        'angle-session', 'climbing', 'bouldering', '2026-07-13T18:00:00Z',
        '2026-07-13T19:00:00Z', 'Angle fixture', 'Kaya', '{}'::jsonb, 'unknown'
      )
    `);
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: kayaProvider,
      entries: [
        {
          externalId: "known-zero",
          activityId,
          discipline: "rock_climbing",
          wallAngle: { value: 0, unit: "degrees" },
          climb: {
            externalId: "vertical",
            kind: "boulder",
            name: "Vertical",
            publishedGrades: [{ value: "V2", system: "v_scale" }],
          },
          attempts: [{ scope: "climb", qualifier: "free-send" }],
        },
        {
          externalId: "unverified-angle",
          activityId,
          discipline: "rock_climbing",
          wallAngle: { value: 40, unit: null },
          climb: {
            externalId: "board",
            kind: "boulder",
            name: "Board",
            publishedGrades: [{ value: "V3", system: "v_scale" }],
          },
          attempts: [{ scope: "climb", qualifier: "free-send" }],
        },
      ],
    });
    const result = await new ClimbingProgressionRepository(
      context.db,
      userId,
      "America/Los_Angeles",
    ).listRange({
      startDate: "2026-07-13",
      endDate: "2026-07-13",
      providers: [],
      filters: {},
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });
    expect(result.sessions[0]?.climbing_log_entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ climb_name: "Vertical", wall_angle_degrees: 0 }),
        expect.objectContaining({ climb_name: "Board", wall_angle_degrees: null }),
      ]),
    );
  });

  it("keeps ungraded participation and evaluates scope and method filters on the same attempt", async () => {
    const activityId = randomUUID();
    await context.db.execute(sql`INSERT INTO fitness.activity
      (id, group_id, provider_id, user_id, external_id, canonical_type, provider_type, started_at, raw)
      VALUES (${activityId}::uuid, ${activityId}::uuid, ${mirrorProvider}, ${userId}::uuid,
        ${activityId}, 'climbing', 'climbing', '2026-07-14T18:00:00Z', '{}'::jsonb)`);
    await persistClimbingLogEntries(context.db, {
      userId,
      providerId: kayaProvider,
      entries: [
        {
          externalId: `ungraded-${activityId}`,
          activityId,
          discipline: "rock_climbing",
          reportedGrades: [{ value: "V17", system: "v_scale" }],
          climb: { externalId: `ungraded-target-${activityId}`, kind: "boulder", name: "Ungraded" },
          attempts: [{ scope: "climb" }],
        },
        {
          externalId: `route-${activityId}`,
          activityId,
          discipline: "rock_climbing",
          climb: {
            externalId: `route-target-${activityId}`,
            kind: "route",
            name: "Mixed methods",
            publishedGrades: [
              { value: "6a", system: "french" },
              { value: "A1", system: "aid" },
            ],
            pitches: [
              {
                externalId: "p1",
                number: 1,
                publishedGrades: [{ value: "5c", system: "french" }],
              },
            ],
          },
          attempts: [
            { scope: "climb", outcome: "completed", ropeMethod: "lead", solo: true, usedAid: true },
            { scope: "climb", qualifier: "free-send", ropeMethod: "top_rope", solo: false },
            {
              scope: "pitch",
              pitch: { externalId: "p1" },
              qualifier: "free-send",
              ropeMethod: "follow",
              solo: false,
            },
          ],
        },
      ],
    });
    const repository = new ClimbingProgressionRepository(context.db, userId, "UTC");
    const input = {
      startDate: "2026-07-14",
      endDate: "2026-07-14",
      providers: [kayaProvider],
      filters: {},
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    };
    const whole = await repository.listRange(input);
    expect(whole.coverage).toMatchObject({ entries: 2, entries_with_attempts: 2 });
    expect(whole.daily[0]).toMatchObject({
      attempts: 3,
      sends: 1,
      failed_attempts: 0,
      unknown_outcomes: 1,
    });
    expect(whole.sessions[0]?.climbing_log_entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ climb_name: "Ungraded", grade: null, grade_system: null }),
      ]),
    );
    expect(whole.grade_distribution).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          grade: "6a",
          rope_method: "lead",
          solo: true,
          used_aid: true,
          sends: 0,
        }),
        expect.objectContaining({
          grade: "6a",
          rope_method: "top_rope",
          solo: false,
          used_aid: false,
          sends: 1,
        }),
      ]),
    );
    expect(whole.grade_distribution).toHaveLength(2);
    const mismatched = await repository.listRange({
      ...input,
      filters: { ropeMethod: "lead", solo: false },
    });
    expect(mismatched.sessions).toEqual([]);
    const pitch = await repository.listRange({
      ...input,
      filters: { attemptScope: "pitch", ropeMethod: "follow" },
    });
    expect(pitch.daily[0]).toMatchObject({ attempts: 1, sends: 1 });
    expect(pitch.grade_distribution).toEqual([
      expect.objectContaining({ grade: "5c", attempt_scope: "pitch" }),
    ]);
  });
});
