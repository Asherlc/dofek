import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { isEncryptedCredentialValue } from "../security/credential-encryption.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import {
  oauthToken,
  provider,
  providerConnection,
  webhookSubscription,
} from "./schema/reference.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import {
  connectProviderWithTokens,
  deleteProviderAuthorization,
  ensureProvider,
  loadTokens,
  saveTokens,
} from "./tokens.ts";
import { executeWithSchema } from "./typed-sql.ts";

const retainedActivitySchema = z.object({ external_id: z.string() });

describe("Token storage (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("ensureProvider inserts a provider row if missing", async () => {
    await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);
    const again = await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);
    expect(again).toBe("wahoo");
  });

  it("saveTokens inserts and loadTokens retrieves", async () => {
    await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);

    const tokens = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    };

    await saveTokens(ctx.db, "wahoo", tokens, TEST_USER_ID);

    const loaded = await loadTokens(ctx.db, "wahoo", TEST_USER_ID);
    expect(loaded).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    });
  });

  it("saveTokens upserts (overwrites existing tokens)", async () => {
    await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);

    await saveTokens(
      ctx.db,
      "wahoo",
      {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        scopes: "user_read",
      },
      TEST_USER_ID,
    );

    await saveTokens(
      ctx.db,
      "wahoo",
      {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date("2026-12-01T00:00:00Z"),
        scopes: "user_read workouts_read",
      },
      TEST_USER_ID,
    );

    const loaded = await loadTokens(ctx.db, "wahoo", TEST_USER_ID);
    expect(loaded?.accessToken).toBe("new-access");
    expect(loaded?.refreshToken).toBe("new-refresh");
  });

  it("isolates provider tokens per user", async () => {
    const firstUserId = "11111111-1111-1111-1111-111111111111";
    const secondUserId = "22222222-2222-2222-2222-222222222222";

    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${firstUserId}, 'User One') ON CONFLICT DO NOTHING`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${secondUserId}, 'User Two') ON CONFLICT DO NOTHING`,
    );
    await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);

    await saveTokens(
      ctx.db,
      "wahoo",
      {
        accessToken: "user-1-access",
        refreshToken: "user-1-refresh",
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        scopes: "user_read",
      },
      firstUserId,
    );
    await saveTokens(
      ctx.db,
      "wahoo",
      {
        accessToken: "user-2-access",
        refreshToken: "user-2-refresh",
        expiresAt: new Date("2026-12-01T00:00:00Z"),
        scopes: "user_read workouts_read",
      },
      secondUserId,
    );

    const firstLoaded = await loadTokens(ctx.db, "wahoo", firstUserId);
    const secondLoaded = await loadTokens(ctx.db, "wahoo", secondUserId);

    expect(firstLoaded?.accessToken).toBe("user-1-access");
    expect(secondLoaded?.accessToken).toBe("user-2-access");
  });

  it("loadTokens returns null for unknown provider", async () => {
    const loaded = await loadTokens(ctx.db, "nonexistent", TEST_USER_ID);
    expect(loaded).toBeNull();
  });

  it("loadTokens returns tokens with null scopes when scopes not set", async () => {
    await ensureProvider(ctx.db, "no-scopes-provider", "No Scopes", undefined, TEST_USER_ID);
    await saveTokens(
      ctx.db,
      "no-scopes-provider",
      {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: new Date("2026-06-01T00:00:00Z"),
        scopes: null,
      },
      TEST_USER_ID,
    );
    const loaded = await loadTokens(ctx.db, "no-scopes-provider", TEST_USER_ID);
    expect(loaded).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: null,
    });
  });

  it("creates independent connections when two users connect the same provider", async () => {
    const firstUserId = "33333333-3333-3333-3333-333333333333";
    const secondUserId = "44444444-4444-4444-4444-444444444444";
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${firstUserId}, 'First Provider User'),
            (${secondUserId}, 'Second Provider User')
          ON CONFLICT DO NOTHING`,
    );

    await ensureProvider(ctx.db, "shared-oauth-provider", "Shared OAuth", undefined, firstUserId);
    await ensureProvider(ctx.db, "shared-oauth-provider", "Shared OAuth", undefined, secondUserId);

    const catalogRows = await ctx.db.execute<{ id: string; name: string }>(
      sql`SELECT id, name FROM fitness.provider WHERE id = 'shared-oauth-provider'`,
    );
    const connectionRows = await ctx.db.execute<{ user_id: string }>(
      sql`SELECT user_id
          FROM fitness.provider_connection
          WHERE provider_id = 'shared-oauth-provider'
          ORDER BY user_id`,
    );
    expect(catalogRows).toEqual([{ id: "shared-oauth-provider", name: "Shared OAuth" }]);
    expect(connectionRows).toEqual([{ user_id: firstUserId }, { user_id: secondUserId }]);
  });

  it("atomically persists a provider connection and encrypted token pair", async () => {
    const providerId = "atomic-token-persistence";
    const tokens = {
      accessToken: "atomic-access-token",
      refreshToken: "atomic-refresh-token",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      scopes: "read write",
    };

    await connectProviderWithTokens(
      ctx.db,
      {
        id: providerId,
        name: "Atomic Token Persistence",
        apiBaseUrl: "https://example.com/api",
      },
      tokens,
      TEST_USER_ID,
    );

    const connectionRows = await ctx.db
      .select({ providerId: providerConnection.providerId })
      .from(providerConnection)
      .where(
        and(
          eq(providerConnection.userId, TEST_USER_ID),
          eq(providerConnection.providerId, providerId),
        ),
      );
    const encryptedRows = await ctx.db
      .select({
        accessToken: oauthToken.accessToken,
        refreshToken: oauthToken.refreshToken,
      })
      .from(oauthToken)
      .where(and(eq(oauthToken.userId, TEST_USER_ID), eq(oauthToken.providerId, providerId)));

    expect(connectionRows).toEqual([{ providerId }]);
    expect(encryptedRows).toHaveLength(1);
    expect(isEncryptedCredentialValue(encryptedRows[0]?.accessToken ?? "")).toBe(true);
    expect(isEncryptedCredentialValue(encryptedRows[0]?.refreshToken ?? "")).toBe(true);
    await expect(loadTokens(ctx.db, providerId, TEST_USER_ID)).resolves.toEqual(tokens);
  });

  it("removes the connection and its credentials while retaining the provider", async () => {
    const providerId = "authorization-reset-provider";
    await connectProviderWithTokens(
      ctx.db,
      {
        id: providerId,
        name: "Authorization Reset Provider",
        apiBaseUrl: "https://example.com/api",
      },
      {
        accessToken: "reset-access-token",
        refreshToken: "reset-refresh-token",
        expiresAt: new Date("2026-09-01T00:00:00Z"),
        scopes: "read",
      },
      TEST_USER_ID,
    );
    await ctx.db.insert(webhookSubscription).values({
      userId: TEST_USER_ID,
      providerId,
      providerName: "Authorization Reset Provider",
      verifyToken: "authorization-reset-verifier",
    });
    await ctx.db.execute(
      sql`INSERT INTO fitness.activity
            (provider_id, user_id, external_id, canonical_type, provider_type, modality, started_at)
          VALUES
            (${providerId}, ${TEST_USER_ID}, 'retained-after-disconnect', 'running', 'running', NULL, now())`,
    );

    await deleteProviderAuthorization(ctx.db, providerId, TEST_USER_ID);

    const connectionRows = await ctx.db
      .select()
      .from(providerConnection)
      .where(
        and(
          eq(providerConnection.userId, TEST_USER_ID),
          eq(providerConnection.providerId, providerId),
        ),
      );
    const tokenRows = await ctx.db
      .select()
      .from(oauthToken)
      .where(and(eq(oauthToken.userId, TEST_USER_ID), eq(oauthToken.providerId, providerId)));
    const webhookRows = await ctx.db
      .select()
      .from(webhookSubscription)
      .where(
        and(
          eq(webhookSubscription.userId, TEST_USER_ID),
          eq(webhookSubscription.providerId, providerId),
        ),
      );
    const providerRows = await ctx.db
      .select({ id: provider.id })
      .from(provider)
      .where(eq(provider.id, providerId));
    const activityRows = await executeWithSchema(
      ctx.db,
      retainedActivitySchema,
      sql`SELECT external_id
          FROM fitness.activity
          WHERE user_id = ${TEST_USER_ID}
            AND provider_id = ${providerId}`,
    );

    expect(connectionRows).toEqual([]);
    expect(tokenRows).toEqual([]);
    expect(webhookRows).toEqual([]);
    expect(providerRows).toEqual([{ id: providerId }]);
    expect(activityRows).toEqual([{ external_id: "retained-after-disconnect" }]);
  });

  it("rolls back a new provider connection when token persistence fails", async () => {
    const providerId = "failed-token-persistence";

    await expect(
      connectProviderWithTokens(
        ctx.db,
        {
          id: providerId,
          name: "Failed Token Persistence",
          apiBaseUrl: "https://example.com/api",
        },
        {
          accessToken: "access-token",
          refreshToken: null,
          expiresAt: new Date(Number.NaN),
          scopes: "read",
        },
        TEST_USER_ID,
      ),
    ).rejects.toThrow();

    const connections = await ctx.db.execute<{ provider_id: string }>(
      sql`SELECT provider_id
          FROM fitness.provider_connection
          WHERE user_id = ${TEST_USER_ID}
            AND provider_id = ${providerId}`,
    );
    expect(connections).toEqual([]);
  });
});
