import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { decryptCredentialValue } from "../../../../src/security/credential-encryption.ts";
import { resolveOrCreateUser } from "./account-linking.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

describe("resolveOrCreateUser (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  beforeEach(async () => {
    await ctx.db.execute(sql`DELETE FROM fitness.session`);
    await ctx.db.execute(sql`DELETE FROM fitness.auth_account`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_profile WHERE id != ${TEST_USER_ID}`);
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile SET email = NULL, name = 'Baseline User' WHERE id = ${TEST_USER_ID}`,
    );
  });

  it("creates a new user for the first external login", async () => {
    const result = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "first@example.com",
      emailVerified: true,
      name: "First User",
    });

    expect(result.userId).not.toBe(TEST_USER_ID);
    expect(result.isNewUser).toBe(true);

    const newUser = await ctx.db.execute<{ email: string; name: string }>(
      sql`SELECT email, name FROM fitness.user_profile WHERE id = ${result.userId}`,
    );
    expect(newUser[0]?.email).toBe("first@example.com");
    expect(newUser[0]?.name).toBe("First User");

    const baseline = await ctx.db.execute<{ email: string | null; name: string }>(
      sql`SELECT email, name FROM fitness.user_profile WHERE id = ${TEST_USER_ID}`,
    );
    expect(baseline[0]?.email).toBeNull();
    expect(baseline[0]?.name).toBe("Baseline User");
  });

  it("creates a new user with the caller-selected fenced user ID", async () => {
    const fencedUserId = "00000000-0000-4000-8000-0000000000f1";

    const result = await resolveOrCreateUser(
      ctx.db,
      "google",
      {
        providerAccountId: "google-fenced-user",
        email: "fenced@example.com",
        emailVerified: true,
        name: "Fenced User",
      },
      undefined,
      { newUserId: fencedUserId },
    );

    expect(result).toEqual({ userId: fencedUserId, isNewUser: true });
  });

  it("returns existing user when auth_account already exists", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "user@example.com",
      emailVerified: true,
      name: "User",
    });

    const second = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "user@example.com",
      emailVerified: true,
      name: "User",
    });

    expect(second.userId).toBe(first.userId);
    expect(second.isNewUser).toBe(false);
  });

  it("auto-links by email when a different provider has the same email", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "shared@example.com",
      emailVerified: true,
      name: "User",
    });

    const second = await resolveOrCreateUser(ctx.db, "apple", {
      providerAccountId: "apple-456",
      email: "shared@example.com",
      emailVerified: true,
      name: "User",
    });

    expect(second.userId).toBe(first.userId);
    expect(second.isNewUser).toBe(false);

    const accounts = await ctx.db.execute<{ auth_provider: string }>(
      sql`SELECT auth_provider FROM fitness.auth_account WHERE user_id = ${first.userId} ORDER BY auth_provider`,
    );
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.auth_provider)).toEqual(["apple", "google"]);
  });

  it("does not auto-link an unverified email matching an existing profile", async () => {
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile SET email = 'shared@example.com' WHERE id = ${TEST_USER_ID}`,
    );

    const result = await resolveOrCreateUser(ctx.db, "strava", {
      providerAccountId: "strava-unverified",
      email: "shared@example.com",
      emailVerified: false,
      name: "Unverified User",
    });

    expect(result.userId).not.toBe(TEST_USER_ID);
    expect(result.isNewUser).toBe(true);

    const profile = await ctx.db.execute<{ email: string | null }>(
      sql`SELECT email FROM fitness.user_profile WHERE id = ${result.userId}`,
    );
    expect(profile[0]?.email).toBeNull();

    const account = await ctx.db.execute<{ email: string | null }>(
      sql`SELECT email FROM fitness.auth_account WHERE user_id = ${result.userId}`,
    );
    expect(account[0]?.email).toBeNull();
  });

  it("does not auto-link an unverified email matching an existing auth account", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-verified",
      email: "shared@example.com",
      emailVerified: true,
      name: "Verified User",
    });

    const second = await resolveOrCreateUser(ctx.db, "strava", {
      providerAccountId: "strava-unverified",
      email: "shared@example.com",
      emailVerified: false,
      name: "Unverified User",
    });

    expect(second.userId).not.toBe(first.userId);
    expect(second.isNewUser).toBe(true);

    const profile = await ctx.db.execute<{ email: string | null }>(
      sql`SELECT email FROM fitness.user_profile WHERE id = ${second.userId}`,
    );
    expect(profile[0]?.email).toBeNull();

    const account = await ctx.db.execute<{ email: string | null }>(
      sql`SELECT email FROM fitness.auth_account WHERE user_id = ${second.userId}`,
    );
    expect(account[0]?.email).toBeNull();
  });

  it("creates a new user when email does not match any existing user", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "first@example.com",
      emailVerified: true,
      name: "First",
    });

    const second = await resolveOrCreateUser(ctx.db, "apple", {
      providerAccountId: "apple-456",
      email: "different@example.com",
      emailVerified: true,
      name: "Second",
    });

    expect(second.userId).not.toBe(first.userId);
    expect(second.userId).not.toBe(TEST_USER_ID);
    expect(second.isNewUser).toBe(true);
  });

  it("links to loggedInUserId regardless of email", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "first@example.com",
      emailVerified: true,
      name: "First",
    });

    const linked = await resolveOrCreateUser(
      ctx.db,
      "apple",
      {
        providerAccountId: "apple-789",
        email: "totally-different@example.com",
        emailVerified: true,
        name: "Different",
      },
      first.userId,
    );

    expect(linked.userId).toBe(first.userId);
    expect(linked.isNewUser).toBe(false);
  });

  it("rejects linking a provider identity owned by another user without mutating either account", async () => {
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile
          SET email = 'link-target@example.test', name = 'Link Target'
          WHERE id = ${TEST_USER_ID}`,
    );
    const owner = await resolveOrCreateUser(ctx.db, "apple", {
      providerAccountId: "apple-owned-account",
      email: "owner@example.test",
      emailVerified: true,
      name: "Original Owner",
      revocationCredential: {
        accessToken: "original-access-token",
        clientId: "original-client",
        refreshToken: "original-refresh-token",
      },
    });
    expect(owner.userId).not.toBe(TEST_USER_ID);

    const profilesBefore = await ctx.db.execute<{
      email: string | null;
      id: string;
      name: string;
    }>(
      sql`SELECT id, email, name
          FROM fitness.user_profile
          WHERE id IN (${TEST_USER_ID}::uuid, ${owner.userId}::uuid)
          ORDER BY id`,
    );
    const accountsBefore = await ctx.db.execute<{
      auth_provider: string;
      email: string | null;
      groups: string[] | null;
      name: string | null;
      provider_account_id: string;
      revocation_access_token: string | null;
      revocation_client_id: string | null;
      revocation_refresh_token: string | null;
      user_id: string;
    }>(
      sql`SELECT
            user_id,
            auth_provider,
            provider_account_id,
            email,
            name,
            groups,
            revocation_access_token,
            revocation_refresh_token,
            revocation_client_id
          FROM fitness.auth_account
          ORDER BY auth_provider, provider_account_id`,
    );

    await expect(
      resolveOrCreateUser(
        ctx.db,
        "apple",
        {
          providerAccountId: "apple-owned-account",
          email: "replacement@example.test",
          emailVerified: true,
          name: "Replacement Owner",
          revocationCredential: {
            accessToken: "replacement-access-token",
            clientId: "replacement-client",
            refreshToken: "replacement-refresh-token",
          },
        },
        TEST_USER_ID,
      ),
    ).rejects.toThrow("apple account is already linked to another user");

    const profilesAfter = await ctx.db.execute<{
      email: string | null;
      id: string;
      name: string;
    }>(
      sql`SELECT id, email, name
          FROM fitness.user_profile
          WHERE id IN (${TEST_USER_ID}::uuid, ${owner.userId}::uuid)
          ORDER BY id`,
    );
    const accountsAfter = await ctx.db.execute<{
      auth_provider: string;
      email: string | null;
      groups: string[] | null;
      name: string | null;
      provider_account_id: string;
      revocation_access_token: string | null;
      revocation_client_id: string | null;
      revocation_refresh_token: string | null;
      user_id: string;
    }>(
      sql`SELECT
            user_id,
            auth_provider,
            provider_account_id,
            email,
            name,
            groups,
            revocation_access_token,
            revocation_refresh_token,
            revocation_client_id
          FROM fitness.auth_account
          ORDER BY auth_provider, provider_account_id`,
    );
    expect(profilesAfter).toEqual(profilesBefore);
    expect(accountsAfter).toEqual(accountsBefore);
  });

  it("encrypts Apple revocation credentials at the repository boundary", async () => {
    const result = await resolveOrCreateUser(ctx.db, "apple", {
      providerAccountId: "apple-revocation-credential",
      email: "apple-revocation@example.test",
      emailVerified: true,
      name: "Apple Revocation",
      revocationCredential: {
        accessToken: "apple-access-token",
        clientId: "com.dofek.app",
        refreshToken: "apple-refresh-token",
      },
    });
    const rows = await ctx.db.execute(
      sql`SELECT
            revocation_access_token,
            revocation_refresh_token,
            revocation_client_id
          FROM fitness.auth_account
          WHERE user_id = ${result.userId}::uuid
            AND auth_provider = 'apple'`,
    );
    const row = rows[0];
    expect(row?.revocation_access_token).toMatch(/^enc:v1:/);
    expect(row?.revocation_refresh_token).toMatch(/^enc:v1:/);
    expect(row?.revocation_client_id).toBe("com.dofek.app");

    const scopeId = "apple:apple-revocation-credential";
    await expect(
      decryptCredentialValue(String(row?.revocation_access_token), {
        tableName: "fitness.auth_account",
        columnName: "revocation_access_token",
        scopeId,
      }),
    ).resolves.toBe("apple-access-token");
    await expect(
      decryptCredentialValue(String(row?.revocation_refresh_token), {
        tableName: "fitness.auth_account",
        columnName: "revocation_refresh_token",
        scopeId,
      }),
    ).resolves.toBe("apple-refresh-token");
  });

  it("repairs a legacy Apple account's revocation credentials on reauthentication", async () => {
    await ctx.db.execute(
      sql`INSERT INTO fitness.auth_account (
            user_id, auth_provider, provider_account_id, email, name
          )
          VALUES (
            ${TEST_USER_ID}::uuid,
            'apple',
            'legacy-apple-account',
            'legacy-apple@example.test',
            'Legacy Apple'
          )`,
    );

    await expect(
      resolveOrCreateUser(ctx.db, "apple", {
        providerAccountId: "legacy-apple-account",
        email: "legacy-apple@example.test",
        emailVerified: true,
        name: "Legacy Apple",
        revocationCredential: {
          accessToken: "fresh-apple-access-token",
          clientId: "com.dofek.app",
          refreshToken: "fresh-apple-refresh-token",
        },
      }),
    ).resolves.toEqual({ isNewUser: false, userId: TEST_USER_ID });

    const rows = await ctx.db.execute(
      sql`SELECT
            revocation_access_token,
            revocation_refresh_token,
            revocation_client_id
          FROM fitness.auth_account
          WHERE auth_provider = 'apple'
            AND provider_account_id = 'legacy-apple-account'`,
    );
    const row = rows[0];
    const scopeId = "apple:legacy-apple-account";
    await expect(
      decryptCredentialValue(String(row?.revocation_access_token), {
        tableName: "fitness.auth_account",
        columnName: "revocation_access_token",
        scopeId,
      }),
    ).resolves.toBe("fresh-apple-access-token");
    await expect(
      decryptCredentialValue(String(row?.revocation_refresh_token), {
        tableName: "fitness.auth_account",
        columnName: "revocation_refresh_token",
        scopeId,
      }),
    ).resolves.toBe("fresh-apple-refresh-token");
    expect(row?.revocation_client_id).toBe("com.dofek.app");
  });

  it("handles null email gracefully (no email-based linking)", async () => {
    await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "user@example.com",
      emailVerified: true,
      name: "User",
    });

    const noEmail = await resolveOrCreateUser(ctx.db, "fitbit", {
      providerAccountId: "fitbit-999",
      email: null,
      emailVerified: false,
      name: "Fitbit User",
    });

    expect(noEmail.userId).not.toBe(TEST_USER_ID);
    expect(noEmail.isNewUser).toBe(true);
  });

  it("upserts auth_account on duplicate provider+accountId (updates email/name)", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "old@example.com",
      emailVerified: true,
      name: "Old Name",
    });

    await resolveOrCreateUser(
      ctx.db,
      "google",
      {
        providerAccountId: "google-123",
        email: "new@example.com",
        emailVerified: true,
        name: "New Name",
      },
      first.userId,
    );

    const accounts = await ctx.db.execute<{ email: string; name: string }>(
      sql`SELECT email, name FROM fitness.auth_account
          WHERE auth_provider = 'google' AND provider_account_id = 'google-123'`,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.email).toBe("new@example.com");
    expect(accounts[0]?.name).toBe("New Name");
  });
});
