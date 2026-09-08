import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { FingerLoadingProgressionRepository } from "./finger-loading-progression-repository.ts";

describe("FingerLoadingProgressionRepository database semantics", () => {
  const userId = randomUUID();
  const primaryProvider = `finger-primary-${randomUUID()}`;
  const mirrorProvider = `finger-mirror-${randomUUID()}`;
  const primaryActivity = randomUUID();
  const mirrorActivity = randomUUID();
  const offsetActivity = randomUUID();
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Finger-loading progression fixture')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        (${primaryProvider}, 'Primary finger fixture', ${userId}::uuid),
        (${mirrorProvider}, 'Mirror finger fixture', ${userId}::uuid)
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, raw, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
      ) VALUES
        (${primaryActivity}::uuid, ${primaryProvider}, ${userId}::uuid, 'primary-session',
          'hangboard', 'strength_training', '2026-07-10T18:00:00Z',
          '2026-07-10T18:30:00Z', 'Max hangs', 'Manual', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${mirrorActivity}::uuid, ${mirrorProvider}, ${userId}::uuid, 'mirror-session',
          'hangboard', 'strength_training', '2026-07-10T18:00:00Z',
          '2026-07-10T18:30:00Z', 'Max hangs mirror', 'Mirror', '{}'::jsonb,
          'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${offsetActivity}::uuid, ${primaryProvider}, ${userId}::uuid, 'offset-session',
          'hangboard', 'strength_training', '2026-07-12T00:30:00Z',
          '2026-07-12T01:00:00Z', 'Assisted hangs', 'Manual', '{}'::jsonb,
          NULL, -420, -420, 'provider_offset')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.finger_loading_entry (
        activity_id, exercise, edge_size_mm, grip_position, external_load_kg,
        bodyweight_kg, laterality, set_count, hold_duration_seconds,
        rest_interval_seconds, rpe, notes
      ) VALUES
        (${primaryActivity}::uuid, 'max_hang', 20, 'half_crimp', 20,
          80, 'both', 5, 10, 180, 8, 'Controlled'),
        (${mirrorActivity}::uuid, 'max_hang', 20, 'half_crimp', 20,
          80, 'both', 5, 10, 180, 8, 'Controlled'),
        (${mirrorActivity}::uuid, 'max_hang', 20, 'half_crimp', 25,
          80, 'both', 5, 10, 180, 9, 'Controlled'),
        (${primaryActivity}::uuid, 'min_edge', 15, 'open_hand', 5,
          80, 'right', 3, 8, 180, 7, 'Unique edge set'),
        (${offsetActivity}::uuid, 'repeater', NULL, NULL, -20,
          80, 'left', 6, 7, 3, NULL, NULL)
    `);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("deduplicates canonical provider overlap and retains all source evidence", async () => {
    const result = await new FingerLoadingProgressionRepository(
      context.db,
      userId,
      "UTC",
    ).listRange({
      startDate: "2026-07-10",
      endDate: "2026-07-10",
      providers: [],
      exercises: [],
      thresholds: {
        minEffectiveLoadKg: 95,
        minLoadToBodyweightRatio: null,
        minRpe: null,
      },
      cursor: null,
      limit: 100,
    });

    expect(result.coverage).toMatchObject({
      sessions: 1,
      entries: 3,
      merged_exact_duplicate_records: 1,
      possible_duplicate_groups: 1,
      entries_excluded_from_aggregates: 2,
    });
    expect(result.summary).toMatchObject({
      entries: 1,
      effective_load_kg_seconds: null,
      total_time_under_tension_seconds: null,
    });
    expect(result.high_intensity).toMatchObject({ matching_entries: 0, days: 0 });
    expect(result.sessions[0]?.member_activity_ids).toEqual(
      expect.arrayContaining([primaryActivity, mirrorActivity]),
    );
    expect(result.sessions[0]).toMatchObject({
      quality_flags: ["possible_overlapping_finger_loading_entries"],
      entries: expect.arrayContaining([
        expect.objectContaining({
          protocol: "max_hang",
          excluded_from_aggregates: true,
          provenance: expect.objectContaining({
            merged_duplicate: true,
            source_activity_ids: expect.arrayContaining([primaryActivity, mirrorActivity]),
            source_providers: expect.arrayContaining([primaryProvider, mirrorProvider]),
          }),
        }),
        expect.objectContaining({
          protocol: "min_edge",
          excluded_from_aggregates: false,
        }),
      ]),
    });
    expect(result.combined_climbing_finger_exposure).toMatchObject({
      first_joint_coverage_date: null,
      daily: [
        {
          date: "2026-07-10",
          finger_loading: true,
          finger_loading_status: "observed",
          climbing: null,
          climbing_status: "unavailable",
          any_exposure: true,
          exposure_status: "observed",
          consecutive_exposure_days: null,
        },
      ],
    });
  });

  it("uses an offset-only local date and preserves signed assistance with missing fields", async () => {
    const result = await new FingerLoadingProgressionRepository(
      context.db,
      userId,
      "Europe/Helsinki",
    ).listRange({
      startDate: "2026-07-11",
      endDate: "2026-07-11",
      providers: [primaryProvider],
      exercises: ["repeater"],
      thresholds: {
        minEffectiveLoadKg: null,
        minLoadToBodyweightRatio: null,
        minRpe: null,
      },
      cursor: null,
      limit: 100,
    });

    expect(result.sessions).toEqual([
      expect.objectContaining({
        activity_id: offsetActivity,
        date: "2026-07-11",
        timezone: expect.objectContaining({
          analysis_timezone: "Europe/Helsinki",
          assumed: false,
          local_time_source: "provider_offset",
        }),
        entries: [
          expect.objectContaining({
            assistance_kg: 20,
            edge_size_mm: null,
            effective_load_kg: 60,
            grip_type: null,
            repetitions_per_set: null,
            rpe: null,
          }),
        ],
      }),
    ]);
  });
});
