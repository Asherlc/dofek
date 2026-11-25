import { randomUUID } from "node:crypto";
import { readGhostMapLabelConsent } from "dofek/db/ghost-map-label-consent";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { SettingsRepository } from "./settings-repository.ts";

describe("current Ghost map-label consent", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(sql`INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}, 'Ghost label owner'), (${otherUserId}, 'Other owner')`);
  });

  afterAll(async () => {
    await context?.cleanup();
  });

  function saveSetting(owner: string, value: boolean | string, updatedAt: string) {
    return context.db.execute(sql`INSERT INTO fitness.user_settings (user_id, key, value, updated_at)
      VALUES (${owner}, 'ghostMapLabels', ${JSON.stringify(value)}::jsonb, ${updatedAt}::timestamptz)
      ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`);
  }

  it("requires JSON boolean true and isolates revisions between owners and re-enables", async () => {
    const firstEnabledAt = "2026-11-24T19:34:56.123456-05:00";
    const withdrawnAt = "2026-11-25T00:34:56.123457Z";
    const enabledAgainAt = "2026-11-25T00:34:56.123458Z";
    await saveSetting(otherUserId, true, firstEnabledAt);
    await expect(readGhostMapLabelConsent(context.db, userId)).resolves.toBeNull();

    await saveSetting(userId, "true", firstEnabledAt);
    await expect(readGhostMapLabelConsent(context.db, userId)).resolves.toBeNull();

    await saveSetting(userId, true, firstEnabledAt);
    const first = await context.db.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL TIME ZONE 'America/New_York'`);
      return readGhostMapLabelConsent(transaction, userId);
    });
    expect(first).toEqual({ revision: "2026-11-25T00:34:56.123456Z" });

    await saveSetting(userId, false, withdrawnAt);
    await expect(readGhostMapLabelConsent(context.db, userId)).resolves.toBeNull();

    await saveSetting(userId, true, enabledAgainAt);
    await expect(readGhostMapLabelConsent(context.db, userId)).resolves.toEqual({
      revision: enabledAgainAt,
    });
    await expect(readGhostMapLabelConsent(context.db, otherUserId)).resolves.toEqual(first);
  });

  it("advances the consent revision on both transitions in the same repository transaction", async () => {
    const owner = randomUUID();
    await context.db.transaction(async (transaction) => {
      await transaction.execute(sql`INSERT INTO fitness.user_profile (id, name)
        VALUES (${owner}, 'Consent transition owner')`);
      const settings = new SettingsRepository(transaction, owner);
      await settings.set("ghostMapLabels", true);
      const first = await readGhostMapLabelConsent(transaction, owner);
      expect(first).not.toBeNull();

      await settings.set("ghostMapLabels", false);
      await expect(readGhostMapLabelConsent(transaction, owner)).resolves.toBeNull();
      const [withdrawal] = await transaction.execute(sql`SELECT
        updated_at = ${first?.revision}::timestamptz + INTERVAL '1 microsecond' AS advanced
        FROM fitness.user_settings WHERE user_id = ${owner} AND key = 'ghostMapLabels'`);
      expect(withdrawal).toEqual({ advanced: true });

      await settings.set("ghostMapLabels", true);
      const reenabled = await readGhostMapLabelConsent(transaction, owner);
      expect(reenabled).not.toBeNull();
      const [reenable] = await transaction.execute(sql`SELECT
        ${reenabled?.revision}::timestamptz = ${first?.revision}::timestamptz
          + INTERVAL '2 microseconds' AS advanced`);
      expect(reenable).toEqual({ advanced: true });
    });
  });
});
