import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  setupTestDatabase,
  type TestContext,
} from "../../../../../src/db/__tests__/test-helpers.ts";
import { resolveOrCreateUser } from "../account-linking.ts";

const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

describe("resolveOrCreateUser (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  beforeEach(async () => {
    // Clean up auth_account and non-default user_profile rows
    await ctx.db.execute(sql`DELETE FROM fitness.session`);
    await ctx.db.execute(sql`DELETE FROM fitness.auth_account`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_profile WHERE id != ${DEFAULT_USER_ID}`);
    // Reset default user email/name
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile SET email = NULL, name = 'Default User' WHERE id = ${DEFAULT_USER_ID}`,
    );
  });

  it("claims DEFAULT_USER_ID for the very first user", async () => {
    const result = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "first@example.com",
      name: "First User",
    });

    expect(result.userId).toBe(DEFAULT_USER_ID);
    expect(result.isNewUser).toBe(true);

    // Verify user_profile was updated
    const rows = await ctx.db.execute<{ email: string; name: string }>(
      sql`SELECT email, name FROM fitness.user_profile WHERE id = ${DEFAULT_USER_ID}`,
    );
    expect(rows[0]?.email).toBe("first@example.com");
    expect(rows[0]?.name).toBe("First User");
  });

  it("returns existing user when auth_account already exists", async () => {
    // Set up: first user
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "user@example.com",
      name: "User",
    });

    // Same provider + account ID should return same user
    const second = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "user@example.com",
      name: "User",
    });

    expect(second.userId).toBe(first.userId);
    expect(second.isNewUser).toBe(false);
  });

  it("auto-links by email when a different provider has the same email", async () => {
    // Set up: first user with Google
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "shared@example.com",
      name: "User",
    });

    // Different provider, same email should link to same user
    const second = await resolveOrCreateUser(ctx.db, "authentik", {
      providerAccountId: "authentik-456",
      email: "shared@example.com",
      name: "User",
    });

    expect(second.userId).toBe(first.userId);
    expect(second.isNewUser).toBe(false);

    // Verify both auth_accounts exist
    const accounts = await ctx.db.execute<{ auth_provider: string }>(
      sql`SELECT auth_provider FROM fitness.auth_account WHERE user_id = ${first.userId} ORDER BY auth_provider`,
    );
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.auth_provider)).toEqual(["authentik", "google"]);
  });

  it("creates a new user when email does not match any existing user", async () => {
    // Set up: first user
    await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "first@example.com",
      name: "First",
    });

    // Different email should create a new user
    const second = await resolveOrCreateUser(ctx.db, "authentik", {
      providerAccountId: "authentik-456",
      email: "different@example.com",
      name: "Second",
    });

    expect(second.userId).not.toBe(DEFAULT_USER_ID);
    expect(second.isNewUser).toBe(true);
  });

  it("links to loggedInUserId regardless of email", async () => {
    // Set up: first user
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "first@example.com",
      name: "First",
    });

    // When loggedInUserId is provided, always link to that user even with different email
    const linked = await resolveOrCreateUser(
      ctx.db,
      "apple",
      {
        providerAccountId: "apple-789",
        email: "totally-different@example.com",
        name: "Different",
      },
      first.userId,
    );

    expect(linked.userId).toBe(first.userId);
    expect(linked.isNewUser).toBe(false);
  });

  it("handles null email gracefully (no email-based linking)", async () => {
    // Set up: first user
    await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "user@example.com",
      name: "User",
    });

    // Provider without email should create a new user (can't auto-link)
    const noEmail = await resolveOrCreateUser(ctx.db, "fitbit", {
      providerAccountId: "fitbit-999",
      email: null,
      name: "Fitbit User",
    });

    expect(noEmail.userId).not.toBe(DEFAULT_USER_ID);
    expect(noEmail.isNewUser).toBe(true);
  });

  it("upserts auth_account on duplicate provider+accountId (updates email/name)", async () => {
    // First login
    await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "old@example.com",
      name: "Old Name",
    });

    // Re-link with updated info (via loggedInUserId)
    await resolveOrCreateUser(
      ctx.db,
      "google",
      {
        providerAccountId: "google-123",
        email: "new@example.com",
        name: "New Name",
      },
      DEFAULT_USER_ID,
    );

    // Verify only one auth_account exists (upserted, not duplicated)
    const accounts = await ctx.db.execute<{ email: string; name: string }>(
      sql`SELECT email, name FROM fitness.auth_account
          WHERE auth_provider = 'google' AND provider_account_id = 'google-123'`,
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.email).toBe("new@example.com");
    expect(accounts[0]?.name).toBe("New Name");
  });
});
