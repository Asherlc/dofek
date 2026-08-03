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
        activity_type,
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
