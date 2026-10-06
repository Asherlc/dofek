import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("unattached climbing entries", () => {
  let context: TestContext;
  let client: Client;
  const userId = "00000000-0000-4000-8000-000000000001";
  const otherUserId = "00000000-0000-4000-8000-000000000002";

  beforeAll(async () => {
    context = await setupTestDatabase();
    client = new Client({ connectionString: context.connectionString });
    await client.connect();
    await client.query(
      `INSERT INTO fitness.user_profile (id, name)
      VALUES ($1, 'Climber'), ($2, 'Other climber') ON CONFLICT DO NOTHING`,
      [userId, otherUserId],
    );
    await client.query(
      `INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('mountain-project', 'Mountain Project', $1) ON CONFLICT DO NOTHING`,
      [userId],
    );
    await client.query(
      `INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('other-provider', 'Other Provider', $1) ON CONFLICT DO NOTHING`,
      [otherUserId],
    );
  });

  afterAll(async () => {
    await client?.end();
    await context?.cleanup();
  });

  it("stores a dated standalone tick with source identity and raw payload", async () => {
    const externalId = `tick-${randomUUID()}`;
    const rows = await client.query(
      `INSERT INTO fitness.climbing_entry (user_id, provider_id, activity_id, unattached_date, external_id, climb_type, grade_system, grade, result_style, attempt_count, source_name, raw) VALUES
        ($1, 'mountain-project', NULL, '2026-09-26', $2, 'boulder', 'v_scale', 'V4', COALESCE(NULLIF(btrim(COALESCE((jsonb_build_object('tickId', $2::text))::jsonb->>'ascentType', (jsonb_build_object('tickId', $2::text))::jsonb->>'attemptType', (jsonb_build_object('tickId', $2::text))::jsonb->>'Lead Style')), ''), 'Send'), 1, 'Boulder Canyon', jsonb_build_object('tickId', $2::text))
RETURNING user_id, provider_id, activity_id, unattached_date::text AS unattached_date, raw`,
      [userId, externalId],
    );
    expect(rows.rows).toEqual([
      {
        user_id: userId,
        provider_id: "mountain-project",
        activity_id: null,
        unattached_date: "2026-09-26",
        raw: { tickId: externalId },
      },
    ]);
    await expect(
      client.query(
        `INSERT INTO fitness.climbing_entry (user_id, provider_id, activity_id, unattached_date, external_id, climb_type, grade_system, grade, result_style, attempt_count) VALUES
        ($1, 'mountain-project', NULL, '2026-09-26', $2, 'boulder', 'v_scale', 'V4', 'Send', 1)
`,
        [userId, externalId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("requires exactly one of activity association and unattached date", async () => {
    const activity = await client.query(
      `INSERT INTO fitness.activity (
      user_id, provider_id, external_id, canonical_type, provider_type, started_at
      ) VALUES ($1, 'mountain-project', $2, 'climbing', 'climbing', now())
    RETURNING id`,
      [userId, `attached-fixture-${randomUUID()}`],
    );
    const activityId = z.object({ id: z.string() }).parse(activity.rows[0]).id;
    const base = `user_id, provider_id, activity_id, unattached_date, external_id, climb_type, grade_system, grade, result_style, attempt_count`;
    await expect(
      client.query(
        `INSERT INTO fitness.climbing_entry (${base}) VALUES
      ($1, 'mountain-project', NULL, NULL, 'none-null', 'boulder', 'v_scale', 'V1', 'Send', 1)`,
        [userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query(
        `INSERT INTO fitness.climbing_entry (${base}) VALUES
      ($1, 'mountain-project', $2, '2026-09-26', 'both-set', 'boulder', 'v_scale', 'V1', 'Send', 1)`,
        [userId, activityId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("does not allow an attached entry to reference another user's activity", async () => {
    const result = await client.query(
      `INSERT INTO fitness.activity (
      user_id, provider_id, external_id, canonical_type, provider_type, started_at
      ) VALUES ($1, 'other-provider', $2, 'climbing', 'climbing', now())
    RETURNING id`,
      [otherUserId, `other-owner-fixture-${randomUUID()}`],
    );
    const activityId = z.object({ id: z.string() }).parse(result.rows[0]).id;
    await expect(
      client.query(
        `INSERT INTO fitness.climbing_entry (user_id, provider_id, activity_id, external_id, climb_type, grade_system, grade, result_style, attempt_count) VALUES
        ($1, 'mountain-project', $2, 'cross-owner', 'boulder', 'v_scale', 'V1', 'Send', 1)
`,
        [userId, activityId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
