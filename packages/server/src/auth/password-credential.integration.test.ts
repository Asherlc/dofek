import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  authenticatePasswordUser,
  DuplicateEmailError,
  InvalidCredentialsError,
  registerPasswordUser,
} from "./password-credential.ts";

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

  it("links password credentials to an existing OAuth user by email", async () => {
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile SET email = 'existing@example.com', name = 'Existing User' WHERE id = ${TEST_USER_ID}`,
    );

    const result = await registerPasswordUser(ctx.db, {
      email: "existing@example.com",
      password: "password123",
    });

    expect(result.userId).toBe(TEST_USER_ID);
    expect(result.isNewUser).toBe(false);
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
});
