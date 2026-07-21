import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  authenticatePasswordUser,
  DuplicateEmailError,
  getPasswordCredentialStatus,
  InvalidCredentialsError,
  registerPasswordUser,
  setPasswordForUser,
} from "./password-credential.ts";
import { createSession, validateSession } from "./session.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";

describe("password credential auth (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  beforeEach(async () => {
    await ctx.db.execute(sql`DELETE FROM fitness.session`);
    await ctx.db.execute(sql`DELETE FROM fitness.password_reset_token`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_password_credential`);
    await ctx.db.execute(sql`DELETE FROM fitness.auth_account`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_profile WHERE id != ${TEST_USER_ID}`);
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile SET email = NULL, name = 'Baseline User' WHERE id = ${TEST_USER_ID}`,
    );
  });

  it("registers a new user with email and password", async () => {
    const result = await registerPasswordUser(ctx.db, {
      email: "new@example.com",
      password: "password123",
      name: "New User",
    });

    expect(result.isNewUser).toBe(true);

    const profile = await ctx.db.execute<{ email: string; name: string }>(
      sql`SELECT email, name FROM fitness.user_profile WHERE id = ${result.userId}`,
    );
    expect(profile[0]?.email).toBe("new@example.com");
    expect(profile[0]?.name).toBe("New User");
  });

  it("does not add a password credential to an existing OAuth user by email", async () => {
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile SET email = 'existing@example.com', name = 'Existing User' WHERE id = ${TEST_USER_ID}`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.auth_account
          (user_id, auth_provider, provider_account_id, email, name)
          VALUES (${TEST_USER_ID}, 'google', 'google-existing', 'existing@example.com', 'Existing User')`,
    );

    await expect(
      registerPasswordUser(ctx.db, {
        email: "existing@example.com",
        password: "password123",
      }),
    ).rejects.toThrow(DuplicateEmailError);

    await expect(getPasswordCredentialStatus(ctx.db, TEST_USER_ID)).resolves.toEqual({
      hasPassword: false,
    });
  });

  it("rejects duplicate password registration for the same email", async () => {
    await registerPasswordUser(ctx.db, {
      email: "dup@example.com",
      password: "password123",
    });

    await expect(
      registerPasswordUser(ctx.db, {
        email: "dup@example.com",
        password: "another-password",
      }),
    ).rejects.toThrow(DuplicateEmailError);
  });

  it("authenticates with valid credentials", async () => {
    const registered = await registerPasswordUser(ctx.db, {
      email: "login@example.com",
      password: "password123",
    });

    const auth = await authenticatePasswordUser(ctx.db, "login@example.com", "password123");
    expect(auth.userId).toBe(registered.userId);
  });

  it("rejects invalid credentials", async () => {
    await registerPasswordUser(ctx.db, {
      email: "login@example.com",
      password: "password123",
    });

    await expect(
      authenticatePasswordUser(ctx.db, "login@example.com", "wrong-password"),
    ).rejects.toThrow(InvalidCredentialsError);
    await expect(
      authenticatePasswordUser(ctx.db, "missing@example.com", "password123"),
    ).rejects.toThrow(InvalidCredentialsError);
  });

  describe("authenticated password management", () => {
    it("creates a password credential for an OAuth-only user with a profile email", async () => {
      await ctx.db.execute(
        sql`UPDATE fitness.user_profile SET email = 'oauth@example.com', name = 'OAuth User' WHERE id = ${TEST_USER_ID}`,
      );

      await expect(getPasswordCredentialStatus(ctx.db, TEST_USER_ID)).resolves.toEqual({
        hasPassword: false,
      });

      await setPasswordForUser(ctx.db, TEST_USER_ID, { newPassword: "new-password123" });

      await expect(
        authenticatePasswordUser(ctx.db, "oauth@example.com", "new-password123"),
      ).resolves.toEqual({ userId: TEST_USER_ID });
      await expect(getPasswordCredentialStatus(ctx.db, TEST_USER_ID)).resolves.toEqual({
        hasPassword: true,
      });
    });

    it("requires the current password when changing an existing password", async () => {
      const registered = await registerPasswordUser(ctx.db, {
        email: "change@example.com",
        password: "password123",
      });

      await expect(
        setPasswordForUser(ctx.db, registered.userId, { newPassword: "new-password123" }),
      ).rejects.toThrow("Current password is required");
    });

    it("changes an existing password when the current password is correct", async () => {
      const registered = await registerPasswordUser(ctx.db, {
        email: "change@example.com",
        password: "password123",
      });

      await setPasswordForUser(ctx.db, registered.userId, {
        currentPassword: "password123",
        newPassword: "new-password123",
      });

      await expect(
        authenticatePasswordUser(ctx.db, "change@example.com", "new-password123"),
      ).resolves.toEqual({ userId: registered.userId });
    });

    it("revokes all sessions and outstanding reset tokens when changing a password", async () => {
      const registered = await registerPasswordUser(ctx.db, {
        email: "change@example.com",
        password: "password123",
      });
      const firstSession = await createSession(ctx.db, registered.userId);
      const secondSession = await createSession(ctx.db, registered.userId);
      await ctx.db.execute(
        sql`INSERT INTO fitness.password_reset_token (user_id, token_hash, expires_at)
            VALUES (${registered.userId}, ${"outstanding-reset-token"}, NOW() + INTERVAL '1 hour')`,
      );

      await setPasswordForUser(ctx.db, registered.userId, {
        currentPassword: "password123",
        newPassword: "new-password123",
      });

      await expect(validateSession(ctx.db, firstSession.sessionId)).resolves.toBeNull();
      await expect(validateSession(ctx.db, secondSession.sessionId)).resolves.toBeNull();
      const tokenRows = await ctx.db.execute(
        sql`SELECT consumed_at FROM fitness.password_reset_token
            WHERE user_id = ${registered.userId}`,
      );
      expect(tokenRows[0]?.consumed_at).not.toBeNull();
    });

    it("fails when an OAuth-only user has no profile email", async () => {
      await expect(
        setPasswordForUser(ctx.db, TEST_USER_ID, { newPassword: "new-password123" }),
      ).rejects.toThrow("Your account needs an email address before you can set a password");
    });
  });
});
