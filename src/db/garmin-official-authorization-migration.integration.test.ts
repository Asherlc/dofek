import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { userSettings } from "./schema/account.ts";
import { activity } from "./schema/activity.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { providerConnection, userProfile } from "./schema/reference.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "./tokens.ts";

describe("official Garmin authorization migration", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("requires private Garmin reconnect while retaining connections, other authorizations, and history", async () => {
    const officialUserId = "62000000-0000-4000-8000-000000000001";
    await context.db
      .insert(userProfile)
      .values({ id: officialUserId, name: "Official Garmin Owner" });
    await ensureProvider(context.db, "garmin", "Garmin", undefined, TEST_USER_ID);
    await ensureProvider(context.db, "garmin", "Garmin", undefined, officialUserId);
    await ensureProvider(context.db, "garmin-dump", "Garmin Export", undefined, TEST_USER_ID);
    const tokens = {
      accessToken: "retained-access",
      refreshToken: "retained-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "garmin-connect-internal",
    };
    await saveTokens(context.db, "garmin", tokens, TEST_USER_ID);
    await saveTokens(context.db, "garmin-dump", tokens, TEST_USER_ID);
    await saveTokens(
      context.db,
      "garmin",
      { ...tokens, scopes: "ACTIVITY_EXPORT", providerAccountId: "official-account" },
      officialUserId,
    );
    await context.db.insert(userSettings).values([
      { userId: TEST_USER_ID, key: "garmin_sync_cursor", value: { lastDate: "2026-10-20" } },
      { userId: TEST_USER_ID, key: "unitSystem", value: "metric" },
    ]);
    await context.db.execute(
      sql`INSERT INTO fitness.activity
            (provider_id, user_id, external_id, canonical_type, provider_type, started_at)
          VALUES ('garmin', ${TEST_USER_ID}, 'retained-garmin-history', 'running', 'running', now())`,
    );
    await context.db.execute(
      sql`ALTER TABLE fitness.oauth_token
          DROP COLUMN provider_account_lookup_id,
          DROP COLUMN authorization_id`,
    );

    const migration = readFileSync(
      new URL("../../drizzle/0153_garmin_official_authorization.sql", import.meta.url),
      "utf8",
    );
    await context.db.transaction(async (transaction) => {
      for (const statement of migration.split("--> statement-breakpoint")) {
        await transaction.execute(sql.raw(statement));
      }
    });

    await expect(loadTokens(context.db, "garmin", TEST_USER_ID)).resolves.toBeNull();
    await expect(loadTokens(context.db, "garmin", officialUserId)).resolves.toMatchObject({
      providerAccountId: "official-account",
      scopes: "ACTIVITY_EXPORT",
    });
    await expect(loadTokens(context.db, "garmin-dump", TEST_USER_ID)).resolves.toEqual(tokens);
    const connections = await context.db
      .select({ userId: providerConnection.userId, providerId: providerConnection.providerId })
      .from(providerConnection)
      .orderBy(providerConnection.userId, providerConnection.providerId);
    expect(connections).toEqual([
      { userId: TEST_USER_ID, providerId: "garmin" },
      { userId: TEST_USER_ID, providerId: "garmin-dump" },
      { userId: officialUserId, providerId: "garmin" },
    ]);
    const retainedHistory = await context.db
      .select({ externalId: activity.externalId })
      .from(activity)
      .where(and(eq(activity.userId, TEST_USER_ID), eq(activity.providerId, "garmin")));
    expect(retainedHistory).toEqual([{ externalId: "retained-garmin-history" }]);
    const settings = await context.db
      .select({ key: userSettings.key, value: userSettings.value })
      .from(userSettings)
      .where(eq(userSettings.userId, TEST_USER_ID))
      .orderBy(userSettings.key);
    expect(settings).toEqual([{ key: "unitSystem", value: "metric" }]);
  });
});
