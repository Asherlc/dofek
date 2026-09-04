import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "./schema/core.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

describe("record-local time context schema", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await ensureProvider(context.db, "local-time-test", "Local Time Test");
    await ensureProvider(context.db, "local-time-offset-test", "Local Time Offset Test");
    await ensureProvider(context.db, "local-time-zone-test", "Local Time Zone Test");
    await context.db.execute(sql`
      INSERT INTO fitness.provider_priority (provider_id, priority)
      VALUES
        ('local-time-offset-test', 10),
        ('local-time-zone-test', 20)
      ON CONFLICT (provider_id) DO UPDATE
      SET priority = EXCLUDED.priority
    `);
  }, 300_000);

  afterAll(async () => {
    await context?.cleanup();
  }, 120_000);

  it("stores independently resolved activity offsets and projects them through v_activity", async () => {
    const externalId = `dst-crossing-activity-${randomUUID()}`;
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        provider_id,
        user_id,
        external_id,
        canonical_type,
        provider_type,
        modality,
        started_at,
        ended_at,
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source
      )
      VALUES (
        'local-time-test',
        ${TEST_USER_ID}::uuid,
        ${externalId}::text,
        'running',
        'running',
        NULL,
        '2026-03-08T09:30:00Z'::timestamptz,
        '2026-03-08T10:30:00Z'::timestamptz,
        'America/Los_Angeles',
        -480,
        -420,
        'provider_timezone'
      )
    `);

    const rows = await context.db.execute<{
      timezone: string;
      start_utc_offset_minutes: number;
      end_utc_offset_minutes: number;
      local_time_source: string;
    }>(sql`
      SELECT
        timezone,
        start_utc_offset_minutes::integer AS start_utc_offset_minutes,
        end_utc_offset_minutes::integer AS end_utc_offset_minutes,
        local_time_source
      FROM fitness.v_activity
      WHERE user_id = ${TEST_USER_ID}::uuid
        AND source_external_ids @> jsonb_build_array(
          jsonb_build_object(
            'providerId',
            'local-time-test',
            'externalId',
            ${externalId}::text
          )
        )
    `);

    expect(rows).toEqual([
      {
        timezone: "America/Los_Angeles",
        start_utc_offset_minutes: -480,
        end_utc_offset_minutes: -420,
        local_time_source: "provider_timezone",
      },
    ]);
  });

  it("projects one internally consistent local-time context for a grouped activity", async () => {
    const offsetExternalId = `offset-member-${randomUUID()}`;
    const zoneExternalId = `zone-member-${randomUUID()}`;

    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        provider_id,
        user_id,
        external_id,
        canonical_type,
        provider_type,
        started_at,
        ended_at,
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source
      )
      VALUES
        (
          'local-time-offset-test',
          ${TEST_USER_ID}::uuid,
          ${offsetExternalId}::text,
          'strength',
          'strength',
          '2026-09-01T14:55:54Z'::timestamptz,
          '2026-09-01T15:55:54Z'::timestamptz,
          NULL,
          -240,
          -240,
          'provider_offset'
        ),
        (
          'local-time-zone-test',
          ${TEST_USER_ID}::uuid,
          ${zoneExternalId}::text,
          'strength',
          'strength',
          '2026-09-01T14:55:54Z'::timestamptz,
          NULL,
          'America/Los_Angeles',
          -420,
          NULL,
          'device_timezone'
        )
    `);

    const rows = await context.db.execute<{
      timezone: string | null;
      start_utc_offset_minutes: number | null;
      end_utc_offset_minutes: number | null;
      local_time_source: string;
    }>(sql`
      SELECT
        timezone,
        start_utc_offset_minutes::integer AS start_utc_offset_minutes,
        end_utc_offset_minutes::integer AS end_utc_offset_minutes,
        local_time_source
      FROM fitness.v_activity
      WHERE user_id = ${TEST_USER_ID}::uuid
        AND source_external_ids @> jsonb_build_array(
          jsonb_build_object(
            'providerId',
            'local-time-zone-test',
            'externalId',
            ${zoneExternalId}::text
          )
        )
    `);

    expect(rows).toEqual([
      {
        timezone: "America/Los_Angeles",
        start_utc_offset_minutes: -420,
        end_utc_offset_minutes: null,
        local_time_source: "device_timezone",
      },
    ]);

    const violations = await context.db.execute(sql`
      WITH persisted_activity_violations AS (
        SELECT 'fitness.activity'::text AS relation_name, id
        FROM fitness.activity
        WHERE provider_absent_at IS NULL
          AND deleted_at IS NULL
          AND (
            (
              local_time_source = 'unknown'
              AND (
                timezone IS NOT NULL
                OR start_utc_offset_minutes IS NOT NULL
                OR end_utc_offset_minutes IS NOT NULL
              )
            )
            OR (
              local_time_source IN (
                'gps_timezone',
                'provider_timezone',
                'device_timezone',
                'user_home_timezone',
                'home_zone_fallback'
              )
              AND timezone IS NULL
            )
            OR (
              local_time_source IN ('provider_offset', 'device_offset')
              AND (
                timezone IS NOT NULL
                OR start_utc_offset_minutes IS NULL
                OR (ended_at IS NOT NULL AND end_utc_offset_minutes IS NULL)
              )
            )
            OR local_time_source NOT IN (
              'unknown',
              'gps_timezone',
              'provider_timezone',
              'device_timezone',
              'user_home_timezone',
              'home_zone_fallback',
              'provider_offset',
              'device_offset'
            )
            OR (
              timezone IS NOT NULL
              AND (
                start_utc_offset_minutes IS DISTINCT FROM round(
                  extract(epoch FROM (
                    (started_at AT TIME ZONE timezone)
                    - (started_at AT TIME ZONE 'UTC')
                  )) / 60
                )::integer
                OR (
                  ended_at IS NOT NULL
                  AND end_utc_offset_minutes IS DISTINCT FROM round(
                    extract(epoch FROM (
                      (ended_at AT TIME ZONE timezone)
                      - (ended_at AT TIME ZONE 'UTC')
                    )) / 60
                  )::integer
                )
              )
            )
          )
      ),
      canonical_activity_violations AS (
        SELECT 'fitness.v_activity'::text AS relation_name, canonical.id
        FROM fitness.v_activity canonical
        WHERE (
            canonical.local_time_source = 'unknown'
            AND (
              canonical.timezone IS NOT NULL
              OR canonical.start_utc_offset_minutes IS NOT NULL
              OR canonical.end_utc_offset_minutes IS NOT NULL
            )
          )
          OR (
            canonical.local_time_source <> 'unknown'
            AND NOT EXISTS (
              SELECT 1
              FROM fitness.activity member
              WHERE member.id = ANY(canonical.member_activity_ids)
                AND member.timezone IS NOT DISTINCT FROM canonical.timezone
                AND member.start_utc_offset_minutes
                  IS NOT DISTINCT FROM canonical.start_utc_offset_minutes
                AND member.end_utc_offset_minutes
                  IS NOT DISTINCT FROM canonical.end_utc_offset_minutes
                AND member.local_time_source = canonical.local_time_source
            )
          )
      )
      SELECT relation_name, id FROM persisted_activity_violations
      UNION ALL
      SELECT relation_name, id FROM canonical_activity_violations
      ORDER BY relation_name, id
    `);

    expect(violations).toEqual([]);
  });

  it("flags but does not expose a retained legacy timezone with unknown provenance", async () => {
    const externalId = `legacy-unknown-zone-${randomUUID()}`;
    await context.db.execute(sql`
      INSERT INTO fitness.activity (
        provider_id,
        user_id,
        external_id,
        canonical_type,
        provider_type,
        started_at,
        ended_at,
        timezone,
        local_time_source
      )
      VALUES (
        'local-time-test',
        ${TEST_USER_ID}::uuid,
        ${externalId}::text,
        'running',
        'running',
        '2026-02-01T18:00:00Z'::timestamptz,
        '2026-02-01T19:00:00Z'::timestamptz,
        'America/Los_Angeles',
        'unknown'
      )
    `);

    const persistedViolations = await context.db.execute<{ violation_count: number }>(sql`
      SELECT COUNT(*)::integer AS violation_count
      FROM fitness.activity
      WHERE external_id = ${externalId}::text
        AND local_time_source = 'unknown'
        AND timezone IS NOT NULL
    `);

    expect(persistedViolations).toEqual([{ violation_count: 1 }]);

    const rows = await context.db.execute<{
      end_utc_offset_minutes: number | null;
      local_time_source: string;
      start_utc_offset_minutes: number | null;
      timezone: string | null;
    }>(sql`
      SELECT
        timezone,
        start_utc_offset_minutes::integer AS start_utc_offset_minutes,
        end_utc_offset_minutes::integer AS end_utc_offset_minutes,
        local_time_source
      FROM fitness.v_activity
      WHERE source_external_ids @> jsonb_build_array(
        jsonb_build_object(
          'providerId',
          'local-time-test',
          'externalId',
          ${externalId}::text
        )
      )
    `);

    expect(rows).toEqual([
      {
        end_utc_offset_minutes: null,
        local_time_source: "unknown",
        start_utc_offset_minutes: null,
        timezone: null,
      },
    ]);
  });

  it("stores offset-only sleep context without inventing a timezone", async () => {
    const externalId = `offset-only-sleep-${randomUUID()}`;
    const rows = await context.db.execute<{
      timezone: string | null;
      start_utc_offset_minutes: number;
      end_utc_offset_minutes: number;
      local_time_source: string;
    }>(sql`
      INSERT INTO fitness.sleep_session (
        provider_id,
        user_id,
        external_id,
        started_at,
        ended_at,
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source
      )
      VALUES (
        'local-time-test',
        ${TEST_USER_ID}::uuid,
        ${externalId}::text,
        '2026-10-24T15:00:00Z'::timestamptz,
        '2026-10-24T17:00:00Z'::timestamptz,
        NULL,
        660,
        600,
        'provider_offset'
      )
      RETURNING
        timezone,
        start_utc_offset_minutes::integer AS start_utc_offset_minutes,
        end_utc_offset_minutes::integer AS end_utc_offset_minutes,
        local_time_source
    `);

    expect(rows).toEqual([
      {
        timezone: null,
        start_utc_offset_minutes: 660,
        end_utc_offset_minutes: 600,
        local_time_source: "provider_offset",
      },
    ]);
  });

  it("defaults records without trusted context to unknown with null offsets", async () => {
    const externalId = `unknown-sleep-${randomUUID()}`;
    const rows = await context.db.execute<{
      start_utc_offset_minutes: number | null;
      end_utc_offset_minutes: number | null;
      local_time_source: string;
    }>(sql`
      INSERT INTO fitness.sleep_session (
        provider_id,
        user_id,
        external_id,
        started_at,
        ended_at
      )
      VALUES (
        'local-time-test',
        ${TEST_USER_ID}::uuid,
        ${externalId}::text,
        '2026-01-01T00:00:00Z'::timestamptz,
        '2026-01-01T08:00:00Z'::timestamptz
      )
      RETURNING
        start_utc_offset_minutes::integer AS start_utc_offset_minutes,
        end_utc_offset_minutes::integer AS end_utc_offset_minutes,
        local_time_source
    `);

    expect(rows).toEqual([
      {
        start_utc_offset_minutes: null,
        end_utc_offset_minutes: null,
        local_time_source: "unknown",
      },
    ]);
  });

  it("rejects an authoritative offset attached to the unknown source", async () => {
    const externalId = `invalid-unknown-sleep-${randomUUID()}`;
    await expect(
      context.db.execute(sql`
        INSERT INTO fitness.sleep_session (
          provider_id,
          user_id,
          external_id,
          started_at,
          start_utc_offset_minutes,
          local_time_source
        )
        VALUES (
          'local-time-test',
          ${TEST_USER_ID}::uuid,
          ${externalId}::text,
          '2026-01-01T00:00:00Z'::timestamptz,
          60,
          'unknown'
        )
      `),
    ).rejects.toMatchObject({
      cause: {
        code: "23514",
        constraint: "sleep_session_local_time_context_check",
      },
    });
  });
});
