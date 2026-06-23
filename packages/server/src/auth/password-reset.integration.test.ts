import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { authenticatePasswordUser, registerPasswordUser } from "./password-credential.ts";
import {
  createPasswordResetToken,
  InvalidPasswordResetTokenError,
  resetPasswordWithToken,
} from "./password-reset.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const mockSendPlainTextEmail = vi.fn().mockResolvedValue(undefined);

vi.mock("../../../../src/email.ts", () => ({
  sendPlainTextEmail: (input: unknown) => mockSendPlainTextEmail(input),
}));

describe("password reset service", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.PUBLIC_APP_URL = "https://app.example.test";
    await ctx.db.execute(sql`DELETE FROM fitness.session`);
    await ctx.db.execute(sql`DELETE FROM fitness.password_reset_token`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_password_credential`);
    await ctx.db.execute(sql`DELETE FROM fitness.auth_account`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_profile WHERE id != ${TEST_USER_ID}`);
    await ctx.db.execute(
      sql`UPDATE fitness.user_profile SET email = NULL, name = 'Baseline User' WHERE id = ${TEST_USER_ID}`,
    );
  });

  it("creates a one-hour reset token and sends a reset email for an existing credential", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });

    const result = await createPasswordResetToken(ctx.db, "reset@example.com");

    expect(result.sent).toBe(true);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mockSendPlainTextEmail).toHaveBeenCalledWith({
      subject: "Reset your Dofek password",
      text: expect.stringContaining(
        `https://app.example.test/reset-password?token=${result.token}`,
      ),
      toEmail: "reset@example.com",
    });

    const rows = await ctx.db.execute<{ token_hash: string; expires_after_minutes: number }>(
      sql`SELECT token_hash, EXTRACT(EPOCH FROM (expires_at - created_at)) / 60 AS expires_after_minutes
          FROM fitness.password_reset_token`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(result.token);
    expect(Math.round(Number(rows[0]?.expires_after_minutes))).toBe(60);
  });

  it("does not send email or reveal existence for an unknown email", async () => {
    const result = await createPasswordResetToken(ctx.db, "missing@example.com");

    expect(result.sent).toBe(false);
    expect(result.token).toBeNull();
    expect(mockSendPlainTextEmail).not.toHaveBeenCalled();
  });

  it("resets the password and consumes the token", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });
    const result = await createPasswordResetToken(ctx.db, "reset@example.com");

    await resetPasswordWithToken(ctx.db, result.token ?? "", "new-password123");

    await expect(
      authenticatePasswordUser(ctx.db, "reset@example.com", "new-password123"),
    ).resolves.toEqual(expect.objectContaining({ userId: expect.any(String) }));
    await expect(
      resetPasswordWithToken(ctx.db, result.token ?? "", "another-password123"),
    ).rejects.toThrow(InvalidPasswordResetTokenError);
  });

  it("rejects expired reset tokens", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });
    const result = await createPasswordResetToken(ctx.db, "reset@example.com");
    await ctx.db.execute(
      sql`UPDATE fitness.password_reset_token SET expires_at = NOW() - INTERVAL '1 minute'`,
    );

    await expect(
      resetPasswordWithToken(ctx.db, result.token ?? "", "new-password123"),
    ).rejects.toThrow(InvalidPasswordResetTokenError);
  });
});
