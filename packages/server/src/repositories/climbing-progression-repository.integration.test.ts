import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
        id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, source_name, raw, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
      ) VALUES
        (${kayaActivity}::uuid, ${kayaProvider}, ${userId}::uuid, 'kaya-session',
          'climbing', 'bouldering', '2026-07-10T18:00:00Z', '2026-07-10T20:00:00Z',
          'Pacific Pipe', 'Kaya', '{}'::jsonb, NULL, NULL, NULL, 'unknown'),
        (${mirrorActivity}::uuid, ${mirrorProvider}, ${userId}::uuid, 'mirror-session',
          'climbing', 'bouldering', '2026-07-10T18:00:00Z', '2026-07-10T20:00:00Z',
          'Pacific Pipe mirror', 'Mirror', '{}'::jsonb, NULL, NULL, NULL, 'unknown'),
        (${offsetActivity}::uuid, ${kayaProvider}, ${userId}::uuid, 'offset-session',
          'climbing', 'bouldering', '2026-07-12T00:30:00Z', '2026-07-12T01:30:00Z',
          'Travel climbing', 'Kaya', '{}'::jsonb, NULL, -420, -420, 'provider_offset')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.climbing_entry (
        activity_id, external_id, climb_type, grade_system, grade, sent,
        attempt_count, wall_angle_degrees, route_name, location_name, source_name, raw
      ) VALUES
        (${kayaActivity}::uuid, 'kaya-blue', 'boulder', 'v_scale', 'V5', true,
          3, 30, 'Blue Arete', 'Pacific Pipe', 'Kaya', '{"ascentType":"Redpoint"}'::jsonb),
        (${mirrorActivity}::uuid, 'mirror-blue', 'boulder', 'v_scale', 'V5', true,
          3, 30, 'Blue Arete', 'Pacific Pipe', 'Mirror', '{"ascentType":"Redpoint"}'::jsonb),
        (${kayaActivity}::uuid, 'kaya-red', 'boulder', 'v_scale', 'V6', NULL,
          NULL, 20, 'Red Roof', 'Pacific Pipe', 'Kaya', '{}'::jsonb),
        (${offsetActivity}::uuid, 'offset-green', 'boulder', 'v_scale', 'V3', true,
          1, 10, 'Green Slab', 'Travel Gym', 'Kaya', '{"ascentType":"Flash"}'::jsonb)
    `);
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
      disciplines: [],
      locations: [],
      gradeSystems: [],
      cursor: null,
      limit: 100,
    });

    expect(result.coverage).toMatchObject({
      sessions: 1,
      entries: 2,
      entries_with_attempts: 1,
      attempt_data: "partial",
      merged_exact_duplicate_records: 1,
    });
    expect(result.daily).toEqual([
      expect.objectContaining({
        attempts: 3,
        attempts_status: "partial",
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
    expect(result.sessions[0]?.climbs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt_count: null,
          route_name: "Red Roof",
          sent: null,
        }),
        expect.objectContaining({
          attempt_count: 3,
          provenance: expect.objectContaining({
            merged_duplicate: true,
            source_providers: expect.arrayContaining([kayaProvider, mirrorProvider]),
          }),
          route_name: "Blue Arete",
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
      disciplines: [],
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
  });
});
