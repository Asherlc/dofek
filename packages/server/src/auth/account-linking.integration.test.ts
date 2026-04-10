import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
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

  it("returns existing user when auth_account already exists", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "user@example.com",
      name: "User",
    });

    const second = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "user@example.com",
      name: "User",
    });

    expect(second.userId).toBe(first.userId);
    expect(second.isNewUser).toBe(false);
  });

  it("auto-links by email when a different provider has the same email", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "shared@example.com",
      name: "User",
    });

    const second = await resolveOrCreateUser(ctx.db, "apple", {
      providerAccountId: "apple-456",
      email: "shared@example.com",
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

  it("creates a new user when email does not match any existing user", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "first@example.com",
      name: "First",
    });

    const second = await resolveOrCreateUser(ctx.db, "apple", {
      providerAccountId: "apple-456",
      email: "different@example.com",
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
      name: "First",
    });

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
    await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "user@example.com",
      name: "User",
    });

    const noEmail = await resolveOrCreateUser(ctx.db, "fitbit", {
      providerAccountId: "fitbit-999",
      email: null,
      name: "Fitbit User",
    });

    expect(noEmail.userId).not.toBe(TEST_USER_ID);
    expect(noEmail.isNewUser).toBe(true);
  });

  it("upserts auth_account on duplicate provider+accountId (updates email/name)", async () => {
    const first = await resolveOrCreateUser(ctx.db, "google", {
      providerAccountId: "google-123",
      email: "old@example.com",
      name: "Old Name",
    });

    await resolveOrCreateUser(
      ctx.db,
      "google",
      {
        providerAccountId: "google-123",
        email: "new@example.com",
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
