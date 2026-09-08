import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { RecoveryActivityExposureRepository } from "./recovery-activity-exposure-repository.ts";

describe("RecoveryActivityExposureRepository database semantics", () => {
  const userId = randomUUID();
  const primaryProvider = `recovery-exposure-primary-${randomUUID()}`;
  const otherProvider = `recovery-exposure-other-${randomUUID()}`;
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Recovery activity exposure fixture')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES
        (${primaryProvider}, 'Primary fixture', ${userId}::uuid),
        (${otherProvider}, 'Other fixture', ${userId}::uuid)
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, provider_id, user_id, external_id, canonical_type, provider_type, modality,
        started_at, ended_at, name, raw, timezone,
        start_utc_offset_minutes, end_utc_offset_minutes, local_time_source
      ) VALUES
        (${randomUUID()}::uuid, ${primaryProvider}, ${userId}::uuid, 'named-zone',
          'cycling', 'cycling', 'indoor', '2026-07-12T00:30:00Z', '2026-07-12T01:30:00Z',
          'Named zone', '{}'::jsonb, 'America/Los_Angeles', -420, -420, 'provider_timezone'),
        (${randomUUID()}::uuid, ${otherProvider}, ${userId}::uuid, 'offset-only',
          'cycling', 'cycling', 'road', '2026-07-12T03:00:00Z', '2026-07-12T03:30:00Z',
          'Offset only', '{}'::jsonb, NULL, -420, -420, 'provider_offset'),
        (${randomUUID()}::uuid, ${otherProvider}, ${userId}::uuid, 'analysis-fallback',
          'walking', 'walking', NULL, '2026-07-12T08:00:00Z', '2026-07-12T08:15:00Z',
          'Analysis fallback', '{}'::jsonb, NULL, NULL, NULL, 'unknown'),
        (${randomUUID()}::uuid, ${primaryProvider}, ${userId}::uuid, 'missing-end',
          'cycling', 'cycling', 'indoor', '2026-07-13T12:00:00Z', NULL,
          'Missing end', '{}'::jsonb, 'America/Los_Angeles', -420, NULL, 'provider_timezone')
    `);
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        id, provider_id, user_id, external_id, canonical_type, provider_type,
        started_at, ended_at, name, raw, local_time_source
      )
      SELECT
        gen_random_uuid(), ${primaryProvider}, ${userId}::uuid, 'bulk-' || index::text,
        'walking', 'walking',
        '2026-07-14T00:00:00Z'::timestamptz + index * INTERVAL '10 minutes',
        '2026-07-14T00:05:00Z'::timestamptz + index * INTERVAL '10 minutes',
        'Bulk ' || index::text, '{}'::jsonb, 'unknown'
      FROM generate_series(0, 104) AS series(index)
    `);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  it("uses named-zone then fixed-offset local dates and labels analysis-timezone fallback", async () => {
    const rows = await new RecoveryActivityExposureRepository(
      context.db,
      userId,
      "Europe/Helsinki",
    ).listDailyExposureRange("2026-07-11", "2026-07-12", {
      providers: [],
      modalities: [],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-07-11",
        activity_count: 2,
        duration_minutes: 90,
        authoritative_date_count: 2,
        assumed_date_count: 0,
      }),
      expect.objectContaining({
        date: "2026-07-12",
        activity_count: 1,
        duration_minutes: 15,
        authoritative_date_count: 0,
        assumed_date_count: 1,
      }),
    ]);
  });

  it("filters canonical activity exposure by provider and modality before aggregation", async () => {
    const rows = await new RecoveryActivityExposureRepository(
      context.db,
      userId,
      "Europe/Helsinki",
    ).listDailyExposureRange("2026-07-11", "2026-07-12", {
      providers: [primaryProvider],
      modalities: ["indoor"],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        date: "2026-07-11",
        activity_count: 1,
        modalities: ["indoor"],
        source_providers: [primaryProvider],
      }),
    ]);
  });

  it("keeps unknown duration distinct from zero and caps provenance IDs", async () => {
    const repository = new RecoveryActivityExposureRepository(context.db, userId, "UTC");
    const missingDuration = await repository.listDailyExposureRange("2026-07-13", "2026-07-13", {
      providers: [],
      modalities: [],
    });
    const bulk = await repository.listDailyExposureRange("2026-07-14", "2026-07-14", {
      providers: [],
      modalities: [],
    });

    expect(missingDuration[0]).toMatchObject({
      duration_minutes: null,
      supported_duration_count: 0,
      missing_end_count: 1,
      invalid_interval_count: 0,
    });
    expect(bulk[0]).toMatchObject({
      activity_count: 105,
      source_activity_ids_truncated: true,
    });
    expect(bulk[0]?.source_activity_ids).toHaveLength(100);
  });

  it("rejects invalid activity intervals at the canonical database boundary", async () => {
    try {
      await context.db.execute(sql`
        INSERT INTO fitness.activity (
          id, provider_id, user_id, external_id, canonical_type, provider_type,
          started_at, ended_at, raw
        ) VALUES (
          ${randomUUID()}::uuid, ${primaryProvider}, ${userId}::uuid, 'invalid-interval',
          'cycling', 'cycling', '2026-07-13T14:00:00Z', '2026-07-13T13:00:00Z', '{}'::jsonb
        )
      `);
      expect.unreachable("Expected the canonical interval constraint to reject the row");
    } catch (error) {
      expect(error).toMatchObject({
        cause: { constraint: "activity_ended_after_started_chk" },
      });
    }
  });
});
