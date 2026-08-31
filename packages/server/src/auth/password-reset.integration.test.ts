import { initiateAccountErasure } from "dofek/db/account-erasure";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { failOnUnhandledExternalRequest } from "../../../../src/test/msw.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { authenticatePasswordUser, registerPasswordUser } from "./password-credential.ts";
import {
  createPasswordResetToken,
  InvalidPasswordResetTokenError,
  resetPasswordWithToken,
} from "./password-reset.ts";
import { createSession, validateSession } from "./session.ts";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const RESET_REQUEST_ERASURE_USER_ID = "10000000-0000-4000-8000-000000001995";
const RESET_CONFIRM_ERASURE_USER_ID = "20000000-0000-4000-8000-000000001995";
const RESET_EMAIL_ERASURE_USER_ID = "30000000-0000-4000-8000-000000001995";
const BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";

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

const brevoEmailInputSchema = z.object({
  sender: z.object({ email: z.string() }),
  subject: z.string(),
  textContent: z.string(),
  to: z.array(z.object({ email: z.string() })),
});
const sentEmails: Array<z.infer<typeof brevoEmailInputSchema>> = [];

const emailServer = setupServer(
  http.post(BREVO_EMAIL_URL, async ({ request }) => {
    sentEmails.push(brevoEmailInputSchema.parse(await request.json()));
    return HttpResponse.json({ messageId: "test-email" }, { status: 201 });
  }),
);

function extractResetTokenFromLastEmail(): string {
  const input = brevoEmailInputSchema.parse(sentEmails.at(-1));
  const match = /\/reset-password\?token=([^\s]+)/.exec(input.textContent);
  if (!match?.[1]) {
    throw new Error("Reset token missing from email");
  }
  return decodeURIComponent(match[1]);
}

function extractResetUrlFromLastEmail(): string {
  const input = brevoEmailInputSchema.parse(sentEmails.at(-1));
  const resetUrl = input.textContent
    .split("\n")
    .find((line) => line.includes("/reset-password?token="));
  if (!resetUrl) {
    throw new Error("Reset URL missing from email");
  }
  return resetUrl;
}

async function waitForAdvisoryLockWaiters(
  connectionString: string,
  minimumWaiters: number,
): Promise<void> {
  const observer = new Client({ connectionString });
  await observer.connect();
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ waiter_count: string }>(
        `SELECT count(DISTINCT waiting_lock.pid)::text AS waiter_count
         FROM pg_locks AS waiting_lock
         JOIN pg_stat_activity AS waiting_activity
           ON waiting_activity.pid = waiting_lock.pid
         WHERE waiting_lock.locktype = 'advisory'
           AND waiting_lock.granted = false
           AND waiting_activity.datname = current_database()
           AND waiting_activity.wait_event = 'advisory'`,
      );
      if (Number(result.rows[0]?.waiter_count ?? 0) >= minimumWaiters) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected at least ${minimumWaiters} advisory-lock waiters`);
  } finally {
    await observer.end();
  }
}

async function waitForErasureEmailOrdering(
  connectionString: string,
  userId: string,
): Promise<"erasure_blocked" | "erasure_committed"> {
  const observer = new Client({ connectionString });
  await observer.connect();
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{
        erasure_committed: boolean;
        erasure_waiting: boolean;
      }>(
        `SELECT
           EXISTS (
             SELECT 1
             FROM fitness.account_erasure_request
             WHERE user_id = $1::uuid
           ) AS erasure_committed,
           EXISTS (
             SELECT 1
             FROM pg_locks AS waiting_lock
             JOIN pg_stat_activity AS waiting_activity
               ON waiting_activity.pid = waiting_lock.pid
             WHERE waiting_lock.locktype = 'advisory'
               AND waiting_lock.granted = false
               AND waiting_activity.datname = current_database()
               AND waiting_activity.wait_event = 'advisory'
               AND waiting_lock.classid::bigint =
                 ((hashtextextended($1::text, 0) >> 32) & 4294967295)
               AND waiting_lock.objid::bigint =
                 (hashtextextended($1::text, 0) & 4294967295)
               AND waiting_lock.objsubid = 1
           ) AS erasure_waiting`,
        [userId],
      );
      const ordering = result.rows[0];
      if (ordering?.erasure_committed) return "erasure_committed";
      if (ordering?.erasure_waiting) return "erasure_blocked";
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Account erasure neither committed nor waited for the reset email");
  } finally {
    await observer.end();
  }
}

describe("password reset service", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    emailServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    ctx = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await ctx?.cleanup();
    emailServer.close();
  });

  beforeEach(async () => {
    sentEmails.length = 0;
    emailServer.resetHandlers();
    process.env.BREVO_API_KEY = "brevo-api-key";
    process.env.EXPORT_EMAIL_FROM = "dofek@dofek.fit";
    process.env.PUBLIC_URL = "https://app.example.test";
    await ctx.db.execute(sql`DELETE FROM fitness.session`);
    await ctx.db.execute(sql`DELETE FROM fitness.password_reset_token`);
    await ctx.db.execute(sql`DELETE FROM fitness.user_password_credential`);
    await ctx.db.execute(sql`DELETE FROM fitness.auth_account`);
    await ctx.db.execute(
      sql`DELETE FROM fitness.user_profile
          WHERE id NOT IN (
            ${TEST_USER_ID}::uuid,
            ${RESET_REQUEST_ERASURE_USER_ID}::uuid,
            ${RESET_CONFIRM_ERASURE_USER_ID}::uuid,
            ${RESET_EMAIL_ERASURE_USER_ID}::uuid
          )`,
    );
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
    expect(sentEmails).toEqual([
      {
        sender: { email: "dofek@dofek.fit" },
        subject: "Reset your Dofek password",
        textContent: expect.stringContaining(
          `https://app.example.test/reset-password?token=${token}`,
        ),
        to: [{ email: "reset@example.com" }],
      },
    ]);

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
    expect(sentEmails).toHaveLength(0);
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
    expect(sentEmails).toHaveLength(0);
  });

  it("fails loudly when the app URL does not use HTTP", async () => {
    process.env.PUBLIC_URL = "file:///tmp/dofek";

    await expect(createPasswordResetToken(ctx.db, "missing@example.com")).rejects.toThrow(
      "PUBLIC_URL environment variable must use http or https",
    );

    expect(sentEmails).toHaveLength(0);
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

  it("returns the same non-enumerating result when erasure wins a reset-request race", async () => {
    await registerPasswordUser(
      ctx.db,
      {
        email: "reset-erasure-request@example.com",
        password: "password123",
        name: "Reset Request Race",
      },
      { newUserId: RESET_REQUEST_ERASURE_USER_ID },
    );
    const blocker = new Client({ connectionString: ctx.connectionString });
    await blocker.connect();
    let blockerReleased = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
        RESET_REQUEST_ERASURE_USER_ID,
      ]);
      const erasure = initiateAccountErasure(
        ctx.db,
        RESET_REQUEST_ERASURE_USER_ID,
        async () => "encrypted-reset-request-race",
        async () => undefined,
      );
      await waitForAdvisoryLockWaiters(ctx.connectionString, 1);
      const resetRequest = createPasswordResetToken(ctx.db, "reset-erasure-request@example.com");
      await waitForAdvisoryLockWaiters(ctx.connectionString, 2);
      await blocker.query("COMMIT");
      blockerReleased = true;

      const [, result] = await Promise.all([erasure, resetRequest]);

      expect(result).toEqual({ sent: false });
      expect(sentEmails).toHaveLength(0);
      const tokens = await executeWithSchema(
        ctx.db,
        tokenCountRowSchema,
        sql`SELECT COUNT(*) AS token_count
            FROM fitness.password_reset_token
            WHERE user_id = ${RESET_REQUEST_ERASURE_USER_ID}::uuid`,
      );
      expect(Number(tokens[0]?.token_count)).toBe(0);
    } finally {
      if (!blockerReleased) await blocker.query("ROLLBACK");
      await blocker.end();
    }
  });

  it("rejects password mutation when erasure wins a reset-confirmation race", async () => {
    await registerPasswordUser(
      ctx.db,
      {
        email: "reset-erasure-confirm@example.com",
        password: "password123",
        name: "Reset Confirmation Race",
      },
      { newUserId: RESET_CONFIRM_ERASURE_USER_ID },
    );
    await createPasswordResetToken(ctx.db, "reset-erasure-confirm@example.com");
    const token = extractResetTokenFromLastEmail();
    const blocker = new Client({ connectionString: ctx.connectionString });
    await blocker.connect();
    let blockerReleased = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
        RESET_CONFIRM_ERASURE_USER_ID,
      ]);
      const erasure = initiateAccountErasure(
        ctx.db,
        RESET_CONFIRM_ERASURE_USER_ID,
        async () => "encrypted-reset-confirm-race",
        async () => undefined,
      );
      await waitForAdvisoryLockWaiters(ctx.connectionString, 1);
      const resetConfirmation = resetPasswordWithToken(ctx.db, token, "new-password123");
      await waitForAdvisoryLockWaiters(ctx.connectionString, 2);
      await blocker.query("COMMIT");
      blockerReleased = true;

      await erasure;
      await expect(resetConfirmation).rejects.toThrow(InvalidPasswordResetTokenError);
      await expect(
        authenticatePasswordUser(ctx.db, "reset-erasure-confirm@example.com", "password123"),
      ).resolves.toEqual({ userId: RESET_CONFIRM_ERASURE_USER_ID });
      await expect(
        authenticatePasswordUser(ctx.db, "reset-erasure-confirm@example.com", "new-password123"),
      ).rejects.toThrow("Invalid email or password");
    } finally {
      if (!blockerReleased) await blocker.query("ROLLBACK");
      await blocker.end();
    }
  });

  it("finishes the reset email before a concurrent erasure can commit", async () => {
    await registerPasswordUser(
      ctx.db,
      {
        email: "reset-erasure-email@example.com",
        password: "password123",
        name: "Reset Email Race",
      },
      { newUserId: RESET_EMAIL_ERASURE_USER_ID },
    );
    let signalEmailStarted: (() => void) | undefined;
    const emailStarted = new Promise<void>((resolve) => {
      signalEmailStarted = resolve;
    });
    let releaseEmailSend: (() => void) | undefined;
    const emailCanFinish = new Promise<void>((resolve) => {
      releaseEmailSend = resolve;
    });
    const operationOrder: string[] = [];
    emailServer.use(
      http.post(BREVO_EMAIL_URL, async ({ request }) => {
        sentEmails.push(brevoEmailInputSchema.parse(await request.json()));
        operationOrder.push("email_started");
        signalEmailStarted?.();
        await emailCanFinish;
        operationOrder.push("email_finished");
        return HttpResponse.json({ messageId: "test-email" }, { status: 201 });
      }),
    );

    const resetRequest = createPasswordResetToken(ctx.db, "reset-erasure-email@example.com");
    await emailStarted;
    const erasure = initiateAccountErasure(
      ctx.db,
      RESET_EMAIL_ERASURE_USER_ID,
      async () => "encrypted-reset-email-race",
      async () => undefined,
    ).then((result) => {
      operationOrder.push("erasure_committed");
      return result;
    });

    try {
      await expect(
        waitForErasureEmailOrdering(ctx.connectionString, RESET_EMAIL_ERASURE_USER_ID),
      ).resolves.toBe("erasure_blocked");
    } finally {
      releaseEmailSend?.();
    }
    await Promise.all([resetRequest, erasure]);

    expect(operationOrder).toEqual(["email_started", "email_finished", "erasure_committed"]);
  });
});
