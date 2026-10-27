import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTaggedQueryClient,
  type TaggedQueryClient,
} from "../../src/db/tagged-query-client.ts";
import { setupTestDatabase, type TestContext } from "../../src/db/test-helpers.ts";
import { listScopedProcessingOperations } from "../../src/processing/processing-event-store.ts";
import { clearSeedData, seedCore } from "./core.ts";
import { USER_ID } from "./helpers.ts";

const LEGACY_USER_ID = "00000000-0000-0000-0000-000000000001";

describe("review seed core", () => {
  let context: TestContext;
  let sql: TaggedQueryClient;

  beforeAll(async () => {
    context = await setupTestDatabase();
    sql = createTaggedQueryClient(context.connectionString);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await context?.cleanup();
  });

  it("seeds an identity accepted by processing runtime boundaries", async () => {
    await seedCore(sql);

    await expect(
      listScopedProcessingOperations(context.db, {
        userId: USER_ID,
      }),
    ).resolves.toEqual([]);
  });

  it("grants the review fixture full paid access", async () => {
    await seedCore(sql);

    const billingRows = await sql`
      SELECT paid_grant_reason
      FROM fitness.user_billing
      WHERE user_id = ${USER_ID}
    `;

    expect(billingRows).toEqual([{ paid_grant_reason: "review_fixture" }]);
  });

  it("clears fixtures created with the previous review user ID", async () => {
    await clearSeedData(sql);
    await sql`DELETE FROM fitness.user_profile WHERE id = ${USER_ID}`;
    await sql`
      INSERT INTO fitness.user_profile (id, name, email)
      VALUES (${LEGACY_USER_ID}, 'Review User', 'review@example.com')
      ON CONFLICT (id) DO UPDATE
        SET name = EXCLUDED.name,
            email = EXCLUDED.email
    `;
    await sql`
      INSERT INTO fitness.session (id, user_id, expires_at)
      VALUES ('legacy-review-session', ${LEGACY_USER_ID}, NOW() + INTERVAL '1 day')
      ON CONFLICT (id) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            expires_at = EXCLUDED.expires_at
    `;

    await clearSeedData(sql);

    const profiles = await sql`
      SELECT id
      FROM fitness.user_profile
      WHERE id = ${LEGACY_USER_ID}
    `;
    const sessions = await sql`
      SELECT id
      FROM fitness.session
      WHERE user_id = ${LEGACY_USER_ID}
    `;
    expect(profiles).toEqual([]);
    expect(sessions).toEqual([]);
  });

  it("clears retained health records for the review user", async () => {
    await clearSeedData(sql);
    await sql`
      INSERT INTO fitness.user_profile (id, name, email)
      VALUES (${USER_ID}, 'Review User', 'review@example.com')
    `;
    await sql`
      INSERT INTO fitness.breathwork_session (
        id, user_id, technique_id, rounds, duration_seconds, started_at
      ) VALUES (
        '55555555-5555-5555-5555-555555555555',
        ${USER_ID},
        'box-breathing',
        4,
        240,
        '2026-08-01T07:00:00Z'
      )
    `;
    await sql`
      INSERT INTO fitness.menstrual_period (id, user_id, start_date, notes)
      VALUES (
        '66666666-6666-6666-6666-666666666666',
        ${USER_ID},
        '2026-08-01',
        'Review cleanup fixture'
      )
    `;

    await clearSeedData(sql);

    const breathworkSessions = await sql`
      SELECT id FROM fitness.breathwork_session WHERE user_id = ${USER_ID}
    `;
    const menstrualPeriods = await sql`
      SELECT id FROM fitness.menstrual_period WHERE user_id = ${USER_ID}
    `;
    expect(breathworkSessions).toEqual([]);
    expect(menstrualPeriods).toEqual([]);
  });
});
