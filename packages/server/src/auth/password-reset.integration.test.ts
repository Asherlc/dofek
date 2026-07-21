import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { authenticatePasswordUser, registerPasswordUser } from "./password-credential.ts";
import {
  createPasswordResetToken,
  InvalidPasswordResetTokenError,
  resetPasswordWithToken,
} from "./password-reset.ts";
import { createSession, validateSession } from "./session.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const mockSendPlainTextEmail = vi.fn().mockResolvedValue(undefined);

const tokenDurationRowSchema = z.object({
  expires_after_minutes: z.union([z.number(), z.string()]),
  token_hash: z.string(),
});

const tokenCountRowSchema = z.object({
  token_count: z.union([z.number(), z.string()]),
});

const tokenConsumedRowSchema = z.object({
  is_unconsumed: z.boolean(),
});

const plainTextEmailInputSchema = z.object({
  text: z.string(),
});

vi.mock("../../../../src/email.ts", () => ({
  sendPlainTextEmail: (input: unknown) => mockSendPlainTextEmail(input),
}));

function extractResetTokenFromLastEmail(): string {
  const input = plainTextEmailInputSchema.parse(mockSendPlainTextEmail.mock.calls.at(-1)?.[0]);
  const match = /\/reset-password\?token=([^\s]+)/.exec(input.text);
  if (!match?.[1]) {
    throw new Error("Reset token missing from email");
  }
  return decodeURIComponent(match[1]);
}

function extractResetUrlFromLastEmail(): string {
  const input = plainTextEmailInputSchema.parse(mockSendPlainTextEmail.mock.calls.at(-1)?.[0]);
  const resetUrl = input.text.split("\n").find((line) => line.includes("/reset-password?token="));
  if (!resetUrl) {
    throw new Error("Reset URL missing from email");
  }
  return resetUrl;
}

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
    process.env.PUBLIC_URL = "https://app.example.test";
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
    const token = extractResetTokenFromLastEmail();

    expect(result).toEqual({ sent: true });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(mockSendPlainTextEmail).toHaveBeenCalledWith({
      subject: "Reset your Dofek password",
      text: expect.stringContaining(`https://app.example.test/reset-password?token=${token}`),
      toEmail: "reset@example.com",
    });

    const rows = await executeWithSchema(
      ctx.db,
      tokenDurationRowSchema,
      sql`SELECT token_hash, EXTRACT(EPOCH FROM (expires_at - created_at)) / 60 AS expires_after_minutes
          FROM fitness.password_reset_token`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(Math.round(Number(rows[0]?.expires_after_minutes))).toBe(60);
  });

  it("does not send email or reveal existence for an unknown email", async () => {
    const result = await createPasswordResetToken(ctx.db, "missing@example.com");

    expect(result).toEqual({ sent: false });
    expect(mockSendPlainTextEmail).not.toHaveBeenCalled();
  });

  it("fails loudly for missing app URL before checking whether the email exists", async () => {
    delete process.env.PUBLIC_URL;

    await expect(createPasswordResetToken(ctx.db, "missing@example.com")).rejects.toThrow(
      "PUBLIC_URL",
    );

    const rows = await executeWithSchema(
      ctx.db,
      tokenCountRowSchema,
      sql`SELECT COUNT(*) AS token_count FROM fitness.password_reset_token`,
    );
    expect(Number(rows[0]?.token_count)).toBe(0);
    expect(mockSendPlainTextEmail).not.toHaveBeenCalled();
  });

  it("fails loudly when the app URL does not use HTTP", async () => {
    process.env.PUBLIC_URL = "file:///tmp/dofek";

    await expect(createPasswordResetToken(ctx.db, "missing@example.com")).rejects.toThrow(
      "PUBLIC_URL environment variable must use http or https",
    );

    expect(mockSendPlainTextEmail).not.toHaveBeenCalled();
  });

  it("normalizes HTTP app URLs before sending reset emails", async () => {
    process.env.PUBLIC_URL = " http://app.example.test/// ";
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });

    await createPasswordResetToken(ctx.db, "reset@example.com");

    const resetUrl = extractResetUrlFromLastEmail();
    expect(resetUrl).toMatch(/^http:\/\/app\.example\.test\/reset-password\?token=/);
    expect(resetUrl).not.toContain("//reset-password");
  });

  it("resets the password and consumes the token", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });
    await createPasswordResetToken(ctx.db, "reset@example.com");
    const token = extractResetTokenFromLastEmail();

    await resetPasswordWithToken(ctx.db, token, "new-password123");

    await expect(
      authenticatePasswordUser(ctx.db, "reset@example.com", "new-password123"),
    ).resolves.toEqual(expect.objectContaining({ userId: expect.any(String) }));
    await expect(resetPasswordWithToken(ctx.db, token, "another-password123")).rejects.toThrow(
      InvalidPasswordResetTokenError,
    );
  });

  it("revokes all sessions and outstanding reset tokens after a password reset", async () => {
    const registered = await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });
    const firstSession = await createSession(ctx.db, registered.userId);
    const secondSession = await createSession(ctx.db, registered.userId);
    await createPasswordResetToken(ctx.db, "reset@example.com");
    const outstandingToken = extractResetTokenFromLastEmail();
    await createPasswordResetToken(ctx.db, "reset@example.com");
    const submittedToken = extractResetTokenFromLastEmail();

    await resetPasswordWithToken(ctx.db, submittedToken, "new-password123");

    await expect(validateSession(ctx.db, firstSession.sessionId)).resolves.toBeNull();
    await expect(validateSession(ctx.db, secondSession.sessionId)).resolves.toBeNull();
    await expect(
      resetPasswordWithToken(ctx.db, outstandingToken, "another-password123"),
    ).rejects.toThrow(InvalidPasswordResetTokenError);
  });

  it("rolls back token consumption when the credential row is missing", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });
    await createPasswordResetToken(ctx.db, "reset@example.com");
    const token = extractResetTokenFromLastEmail();
    await ctx.db.execute(
      sql`DELETE FROM fitness.user_password_credential WHERE email = ${"reset@example.com"}`,
    );

    await expect(resetPasswordWithToken(ctx.db, token, "new-password123")).rejects.toThrow(
      InvalidPasswordResetTokenError,
    );

    const rows = await executeWithSchema(
      ctx.db,
      tokenConsumedRowSchema,
      sql`SELECT consumed_at IS NULL AS is_unconsumed FROM fitness.password_reset_token`,
    );
    expect(rows).toEqual([{ is_unconsumed: true }]);
  });

  it("allows only one concurrent reset with the same token", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });
    await createPasswordResetToken(ctx.db, "reset@example.com");
    const token = extractResetTokenFromLastEmail();

    await ctx.db.execute(sql`DROP TRIGGER IF EXISTS delay_password_reset_consume_trigger
        ON fitness.password_reset_token`);
    await ctx.db.execute(sql`DROP FUNCTION IF EXISTS fitness.delay_password_reset_consume()`);
    await ctx.db.execute(sql`CREATE OR REPLACE FUNCTION fitness.delay_password_reset_consume()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM pg_sleep(0.2);
          RETURN NEW;
        END
        $$`);
    await ctx.db.execute(sql`CREATE TRIGGER delay_password_reset_consume_trigger
        BEFORE UPDATE OF consumed_at ON fitness.password_reset_token
        FOR EACH ROW
        WHEN (OLD.consumed_at IS NULL AND NEW.consumed_at IS NOT NULL)
        EXECUTE FUNCTION fitness.delay_password_reset_consume()`);

    try {
      const resetResults = await Promise.allSettled([
        resetPasswordWithToken(ctx.db, token, "new-password123"),
        resetPasswordWithToken(ctx.db, token, "another-password123"),
      ]);

      const fulfilledResults = resetResults.filter(
        (resetResult) => resetResult.status === "fulfilled",
      );
      const rejectedResults = resetResults.filter(
        (resetResult) => resetResult.status === "rejected",
      );
      expect(fulfilledResults).toHaveLength(1);
      expect(rejectedResults).toHaveLength(1);
      expect(rejectedResults[0]?.reason).toBeInstanceOf(InvalidPasswordResetTokenError);
    } finally {
      await ctx.db.execute(sql`DROP TRIGGER IF EXISTS delay_password_reset_consume_trigger
          ON fitness.password_reset_token`);
      await ctx.db.execute(sql`DROP FUNCTION IF EXISTS fitness.delay_password_reset_consume()`);
    }
  });

  it("rejects expired reset tokens", async () => {
    await registerPasswordUser(ctx.db, {
      email: "reset@example.com",
      password: "password123",
      name: "Reset User",
    });
    await createPasswordResetToken(ctx.db, "reset@example.com");
    const token = extractResetTokenFromLastEmail();
    await ctx.db.execute(
      sql`UPDATE fitness.password_reset_token SET expires_at = NOW() - INTERVAL '1 minute'`,
    );

    await expect(resetPasswordWithToken(ctx.db, token, "new-password123")).rejects.toThrow(
      InvalidPasswordResetTokenError,
    );
  });
});
