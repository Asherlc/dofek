import { eq, type SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import type { Database, SyncDatabase, TransactionDatabase } from "./index.ts";
import { notifyProviderSyncIssue } from "./provider-issue-notification.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { syncLog } from "./schema/events.ts";
import { providerConnection, userProfile } from "./schema/reference.ts";
import { logSync, type SyncLogEntry } from "./sync-log.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "./test-helpers.ts";
import { ensureProvider } from "./tokens.ts";

const BREVO_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";
const OTHER_USER_ID = "00000000-0000-0000-0000-000000000002";
const server = setupServer();

describe("provider issue email delivery", () => {
  let context: TestContext;
  let emailRequests: unknown[];

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    context = await setupTestDatabase();
    await context.db.insert(userProfile).values({ id: OTHER_USER_ID, name: "Other User" });
  }, 120_000);

  beforeEach(async () => {
    vi.stubEnv("BREVO_API_KEY", "test-brevo-api-key");
    vi.stubEnv("EXPORT_EMAIL_FROM", "dofek@example.test");
    emailRequests = [];
    server.use(
      http.post(BREVO_EMAIL_URL, async ({ request }) => {
        emailRequests.push(await request.json());
        return HttpResponse.json({ messageId: "test-message" }, { status: 201 });
      }),
    );
    await context.db.delete(syncLog);
    await context.db.delete(providerConnection);
    await context.db
      .update(userProfile)
      .set({ email: "user@example.test" })
      .where(eq(userProfile.id, TEST_USER_ID));
    await context.db
      .update(userProfile)
      .set({ email: "other@example.test" })
      .where(eq(userProfile.id, OTHER_USER_ID));
    await ensureProvider(context.db, "issue-provider", "Test Provider", undefined, TEST_USER_ID);
  });

  afterEach(() => {
    server.resetHandlers();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    server.close();
    await context?.cleanup();
  });

  async function recordFailure(overrides: Partial<SyncLogEntry> = {}): Promise<void> {
    await logSync(context.db, {
      providerId: "issue-provider",
      userId: TEST_USER_ID,
      dataType: "sync",
      status: "error",
      origin: "scheduled",
      errorMessage: "Upstream failed: private-token",
      ...overrides,
    });
  }

  async function recordRecovery(origin: "manual" | "scheduled" = "scheduled"): Promise<void> {
    await logSync(context.db, {
      providerId: "issue-provider",
      userId: TEST_USER_ID,
      dataType: "sync",
      status: "success",
      origin,
    });
  }

  it("emails immediately when a manual sync confirms refresh credentials are revoked", async () => {
    await recordFailure({ origin: "manual", authFailureReason: "refresh_token_revoked" });

    expect(emailRequests).toHaveLength(1);
    expect(emailRequests[0]).toMatchObject({
      to: [{ email: "user@example.test" }],
      subject: expect.stringContaining("Test Provider"),
      textContent: expect.stringContaining("Reconnect Test Provider"),
    });
    expect(emailRequests[0]).toMatchObject({
      textContent: expect.stringContaining("https://dofek.fit/providers/issue-provider"),
    });
    expect(JSON.stringify(emailRequests)).not.toContain("private-token");
  });

  it("emails after two scheduled failures and suppresses further alerts during the issue", async () => {
    await recordFailure();
    expect(emailRequests).toHaveLength(0);

    await recordFailure();
    expect(emailRequests).toHaveLength(1);
    expect(emailRequests[0]).toMatchObject({
      textContent: expect.stringContaining("automatic syncs"),
    });

    await recordFailure();
    expect(emailRequests).toHaveLength(1);
  });

  it.each([
    "authorization_failed",
    "access_token_expired",
    "session_expired",
    "authentication_failed",
  ] as const)(
    "does not email when a scheduled %s failure recovers on the next attempt",
    async (authFailureReason) => {
      await recordFailure({ authFailureReason });
      expect(emailRequests).toHaveLength(0);
      await recordRecovery();
      await recordFailure({ authFailureReason });
      expect(emailRequests).toHaveLength(0);
      await recordRecovery();
      expect(emailRequests).toHaveLength(0);
    },
  );

  it("emails once when request authorization still fails on the next scheduled attempt", async () => {
    await recordFailure({ authFailureReason: "authorization_failed" });
    expect(emailRequests).toHaveLength(0);
    await recordFailure({ authFailureReason: "authorization_failed" });
    expect(emailRequests).toHaveLength(1);
    expect(emailRequests[0]).toMatchObject({
      textContent: expect.stringContaining("Reconnect Test Provider"),
    });
    await recordFailure({ authFailureReason: "authorization_failed" });
    expect(emailRequests).toHaveLength(1);
  });

  it("waits for an automatic attempt after a manual authorization failure", async () => {
    await recordFailure({ origin: "manual", authFailureReason: "authorization_failed" });
    await recordFailure({ origin: "manual", authFailureReason: "authorization_failed" });
    expect(emailRequests).toHaveLength(0);
    await recordFailure({ authFailureReason: "authorization_failed" });
    expect(emailRequests).toHaveLength(1);
  });

  it("confirms an authorization issue when the next automatic attempt fails for another reason", async () => {
    await recordFailure({ origin: "manual", authFailureReason: "authorization_failed" });
    expect(emailRequests).toHaveLength(0);
    await recordFailure();
    expect(emailRequests).toHaveLength(1);
    expect(emailRequests[0]).toMatchObject({
      textContent: expect.stringContaining("Reconnect Test Provider"),
    });
  });

  it("clears a manual authorization failure when the next automatic attempt recovers", async () => {
    await recordFailure({ origin: "manual", authFailureReason: "authorization_failed" });
    expect(emailRequests).toHaveLength(0);
    await recordRecovery();
    await recordFailure();
    expect(emailRequests).toHaveLength(0);
  });

  it("sends only one authorization warning until recovery", async () => {
    await recordFailure({ authFailureReason: "refresh_token_revoked" });
    await recordFailure({ authFailureReason: "refresh_token_revoked" });

    expect(emailRequests).toHaveLength(1);
  });

  it.each(["manual", "scheduled"] as const)(
    "allows a new authorization alert after a successful %s sync",
    async (origin) => {
      await recordFailure({ authFailureReason: "refresh_token_revoked" });
      await recordRecovery(origin);
      await recordFailure({ authFailureReason: "refresh_token_revoked" });

      expect(emailRequests).toHaveLength(2);
    },
  );

  it.each(["manual", "scheduled"] as const)(
    "resets the scheduled failure streak after a successful %s sync",
    async (origin) => {
      await recordFailure();
      await recordFailure();
      await recordRecovery(origin);
      await recordFailure();
      expect(emailRequests).toHaveLength(1);

      await recordFailure();
      expect(emailRequests).toHaveLength(2);
    },
  );

  it("allows a new alert when recovery waits for an email response", async () => {
    const emailStarted = createTestBarrier();
    const releaseEmail = createTestBarrier();
    server.use(
      http.post(BREVO_EMAIL_URL, async ({ request }) => {
        emailRequests.push(await request.json());
        emailStarted.resolve();
        await releaseEmail.promise;
        return HttpResponse.json({ messageId: "test-message" }, { status: 201 });
      }),
    );
    const failure = recordFailure({ authFailureReason: "refresh_token_revoked" });
    await emailStarted.promise;
    const recovery = recordRecovery();
    const completion = Promise.allSettled([failure, recovery]);
    try {
      await expect.poll(() => hasDatabaseLockWaiter(context.db)).toBe(true);
    } finally {
      releaseEmail.resolve();
      await completion;
    }
    expect(await completion).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);
    await recordFailure({ authFailureReason: "refresh_token_revoked" });

    expect(emailRequests).toHaveLength(2);
  });

  it("does not count manual errors toward the scheduled failure threshold", async () => {
    await recordFailure({ origin: "manual" });
    await recordFailure({ origin: "manual" });
    await recordFailure();
    expect(emailRequests).toHaveLength(0);

    await recordFailure();
    expect(emailRequests).toHaveLength(1);
  });

  it("waits for the overall sync outcome instead of alerting on individual data steps", async () => {
    await recordFailure({ dataType: "activities", authFailureReason: "refresh_token_revoked" });
    await recordFailure({ dataType: "sleep" });
    expect(emailRequests).toHaveLength(0);

    await recordFailure({ authFailureReason: "refresh_token_revoked" });
    expect(emailRequests).toHaveLength(1);
  });

  it("keeps an issue active when only one data step succeeds", async () => {
    await recordFailure({ authFailureReason: "refresh_token_revoked" });
    await logSync(context.db, {
      providerId: "issue-provider",
      userId: TEST_USER_ID,
      dataType: "sleep",
      status: "success",
    });
    await recordFailure({ authFailureReason: "refresh_token_revoked" });

    expect(emailRequests).toHaveLength(1);
  });

  it("suppresses duplicate delivery from concurrent failure notifications", async () => {
    await Promise.all([
      recordFailure({ authFailureReason: "refresh_token_revoked" }),
      recordFailure({ authFailureReason: "refresh_token_revoked" }),
    ]);

    expect(emailRequests).toHaveLength(1);
  });

  it("records a scheduled failure while another notification is waiting without deadlocking", async () => {
    await context.db.insert(syncLog).values({
      providerId: "issue-provider",
      userId: TEST_USER_ID,
      dataType: "sync",
      status: "error",
      origin: "scheduled",
      authFailureReason: "refresh_token_revoked",
    });
    const providerLockAcquired = createTestBarrier();
    const releaseFailureInsert = createTestBarrier();
    const gatedDatabase: SyncDatabase & Pick<Database, "transaction"> = {
      select: context.db.select.bind(context.db),
      insert: context.db.insert.bind(context.db),
      delete: context.db.delete.bind(context.db),
      execute: context.db.execute.bind(context.db),
      transaction<T>(operation: (transaction: TransactionDatabase) => Promise<T>): Promise<T> {
        return context.db.transaction((transaction) =>
          operation({
            ...transaction,
            async execute<TRow extends Record<string, unknown> = Record<string, unknown>>(
              query: SQLWrapper | string,
            ): Promise<TRow[]> {
              const rows = await transaction.execute<TRow>(query);
              const statement =
                typeof query === "string" ? query : new PgDialect().sqlToQuery(query.getSQL()).sql;
              if (statement.includes("pg_advisory_xact_lock")) {
                providerLockAcquired.resolve();
                await releaseFailureInsert.promise;
              }
              return rows;
            },
          }),
        );
      },
    };
    const failure = logSync(gatedDatabase, {
      providerId: "issue-provider",
      userId: TEST_USER_ID,
      dataType: "sync",
      status: "error",
      origin: "scheduled",
      authFailureReason: "refresh_token_revoked",
    });
    await providerLockAcquired.promise;
    const notification = notifyProviderSyncIssue(context.db, TEST_USER_ID, "issue-provider");
    const completion = Promise.allSettled([failure, notification]);
    try {
      await expect.poll(() => hasDatabaseLockWaiter(context.db)).toBe(true);
    } finally {
      releaseFailureInsert.resolve();
      await completion;
    }

    expect(await completion).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);

    expect(emailRequests).toHaveLength(1);
    expect(await context.db.select().from(syncLog)).toHaveLength(2);
  });

  it("tracks notifications independently for each user and provider", async () => {
    await ensureProvider(context.db, "issue-provider", "Test Provider", undefined, OTHER_USER_ID);
    await ensureProvider(context.db, "other-provider", "Other Provider", undefined, TEST_USER_ID);

    await recordFailure({ authFailureReason: "refresh_token_revoked" });
    await recordFailure({ authFailureReason: "refresh_token_revoked", userId: OTHER_USER_ID });
    await recordFailure({
      authFailureReason: "refresh_token_revoked",
      providerId: "other-provider",
    });

    expect(emailRequests).toHaveLength(3);
    expect(emailRequests[1]).toMatchObject({ to: [{ email: "other@example.test" }] });
    expect(emailRequests[2]).toMatchObject({ subject: expect.stringContaining("Other Provider") });
  });

  it("retries unsuccessful email delivery on the next failed sync without failing sync logging", async () => {
    server.use(
      http.post(BREVO_EMAIL_URL, async ({ request }) => {
        emailRequests.push(await request.json());
        return HttpResponse.json({ message: "Email service unavailable" }, { status: 503 });
      }),
    );
    await expect(
      recordFailure({ authFailureReason: "refresh_token_revoked" }),
    ).resolves.toBeUndefined();

    server.resetHandlers();
    server.use(
      http.post(BREVO_EMAIL_URL, async ({ request }) => {
        emailRequests.push(await request.json());
        return HttpResponse.json({ messageId: "test-message" }, { status: 201 });
      }),
    );
    await recordFailure({ authFailureReason: "refresh_token_revoked" });
    await recordFailure({ authFailureReason: "refresh_token_revoked" });

    expect(emailRequests).toHaveLength(2);
    expect(await context.db.select().from(syncLog)).toHaveLength(3);
  });

  it("retries an unaccepted authorization warning after a different manual sync error", async () => {
    server.use(
      http.post(
        BREVO_EMAIL_URL,
        async ({ request }) => {
          emailRequests.push(await request.json());
          return HttpResponse.json({ message: "Email service unavailable" }, { status: 503 });
        },
        { once: true },
      ),
    );
    await recordFailure({ origin: "manual", authFailureReason: "refresh_token_revoked" });
    await recordFailure({ origin: "manual" });
    await recordFailure({ origin: "manual" });

    expect(emailRequests).toHaveLength(2);
    expect(emailRequests[1]).toMatchObject({
      textContent: expect.stringContaining("Reconnect Test Provider"),
    });
  });

  it.each(["manual", "scheduled"] as const)(
    "clears a pending authorization warning after a successful %s sync",
    async (origin) => {
      await context.db
        .update(userProfile)
        .set({ email: null })
        .where(eq(userProfile.id, TEST_USER_ID));
      await recordFailure({ origin: "manual", authFailureReason: "refresh_token_revoked" });
      await recordRecovery(origin);
      await context.db
        .update(userProfile)
        .set({ email: "user@example.test" })
        .where(eq(userProfile.id, TEST_USER_ID));
      await recordFailure({ origin: "manual" });
      expect(emailRequests).toHaveLength(0);

      await recordFailure();
      await recordFailure();
      expect(emailRequests).toHaveLength(1);
      expect(emailRequests[0]).toMatchObject({
        textContent: expect.stringContaining("automatic syncs"),
      });
    },
  );

  it("does not carry a pending authorization warning into a new connection", async () => {
    await context.db
      .update(userProfile)
      .set({ email: null })
      .where(eq(userProfile.id, TEST_USER_ID));
    await recordFailure({ origin: "manual", authFailureReason: "refresh_token_revoked" });
    await context.db.delete(providerConnection);
    await ensureProvider(context.db, "issue-provider", "Test Provider", undefined, TEST_USER_ID);
    await context.db
      .update(userProfile)
      .set({ email: "user@example.test" })
      .where(eq(userProfile.id, TEST_USER_ID));

    await recordFailure({ origin: "manual" });
    expect(emailRequests).toHaveLength(0);
    await recordFailure({ origin: "manual", authFailureReason: "refresh_token_revoked" });
    expect(emailRequests).toHaveLength(1);
  });

  it("does not treat an individual data-step auth error as an overall authorization issue", async () => {
    await recordFailure({ dataType: "sleep", authFailureReason: "refresh_token_revoked" });
    await recordFailure({ origin: "manual" });
    expect(emailRequests).toHaveLength(0);

    await recordFailure();
    await recordFailure();
    expect(emailRequests).toHaveLength(1);
    expect(emailRequests[0]).toMatchObject({
      textContent: expect.stringContaining("automatic syncs"),
    });
  });

  it("retries a rejected repeated-failure email after a degraded sync and another failure", async () => {
    server.use(
      http.post(
        BREVO_EMAIL_URL,
        async ({ request }) => {
          emailRequests.push(await request.json());
          return HttpResponse.json({ message: "Email service unavailable" }, { status: 503 });
        },
        { once: true },
      ),
    );
    await recordFailure();
    await recordFailure();
    await logSync(context.db, {
      providerId: "issue-provider",
      userId: TEST_USER_ID,
      dataType: "sync",
      status: "degraded",
      origin: "scheduled",
    });
    await recordFailure();
    await recordFailure();

    expect(emailRequests).toHaveLength(2);
    expect(emailRequests[1]).toMatchObject({
      textContent: expect.stringContaining("automatic syncs"),
    });
  });

  it("waits until a recipient email is available", async () => {
    await context.db
      .update(userProfile)
      .set({ email: null })
      .where(eq(userProfile.id, TEST_USER_ID));
    await recordFailure({ authFailureReason: "refresh_token_revoked" });
    expect(emailRequests).toHaveLength(0);

    await context.db
      .update(userProfile)
      .set({ email: "user@example.test" })
      .where(eq(userProfile.id, TEST_USER_ID));
    await recordFailure({ authFailureReason: "refresh_token_revoked" });

    expect(emailRequests).toHaveLength(1);
  });

  it("does not email about a disconnected provider", async () => {
    await context.db.delete(providerConnection);
    await recordFailure({ authFailureReason: "refresh_token_revoked" });

    expect(emailRequests).toHaveLength(0);
  });
});
