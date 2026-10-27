import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountErasureRestoreIntent } from "../../../../src/account-erasure/restore-ledger.ts";
import { deleteExpiredAccountErasurePreparations } from "../../../../src/db/account-erasure-processing.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../../../../src/db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../../../../src/test/msw.ts";
import { createSession } from "../auth/session.ts";
import { createApp } from "../index.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

const accountErasureUserId = "30000000-0000-4000-8000-000000001994";
const guardedAccountErasureUserId = "40000000-0000-4000-8000-000000001994";
const stripeSecretKey = "sk_test_account_erasure_router";
let stripeCustomerDiscoveryRequests = 0;
const externalApiServer = setupServer(
  http.get("https://api.stripe.com/v1/customers", ({ request }) => {
    expect(request.headers.get("authorization")).toBe(`Bearer ${stripeSecretKey}`);
    expect(new URL(request.url).searchParams.get("limit")).toBe("100");
    stripeCustomerDiscoveryRequests += 1;
    return HttpResponse.json({
      data: [],
      has_more: false,
      object: "list",
      url: "/v1/customers",
    });
  }),
);

describe("account erasure router (integration)", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;
  let context: TestContext;
  let guardedSessionId: string;
  let sessionId: string;
  const originalStripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const restoreIntents: AccountErasureRestoreIntent[] = [];

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = stripeSecretKey;
    externalApiServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES
            (
              ${accountErasureUserId}::uuid,
              'Account Erasure API User',
              'account-erasure-api@example.test'
            ),
            (
              ${guardedAccountErasureUserId}::uuid,
              'Guarded Account Erasure API User',
              'guarded-account-erasure-api@example.test'
            )`,
    );
    const session = await createSession(context.db, accountErasureUserId);
    sessionId = session.sessionId;
    const guardedSession = await createSession(context.db, guardedAccountErasureUserId);
    guardedSessionId = guardedSession.sessionId;
    await ensureProvider(
      context.db,
      "coros",
      "COROS",
      "https://open.coros.com",
      guardedAccountErasureUserId,
    );
    await saveTokens(
      context.db,
      "coros",
      {
        accessToken: "guarded-coros-access",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshToken: "guarded-coros-refresh",
        scopes: null,
      },
      guardedAccountErasureUserId,
    );

    const app = createApp(context.db, makeMockSensorStore(), {
      accountErasureRestoreLedger: {
        findIntent: async (reference) =>
          restoreIntents.find(
            (candidate) =>
              candidate.keyId === reference.keyId &&
              candidate.requestId === reference.requestId &&
              candidate.userHash === reference.userHash,
          ) ?? null,
        listIntentReferences: async () =>
          restoreIntents.map(({ keyId, requestId, userHash }) => ({
            keyId,
            requestId,
            userHash,
          })),
        listIntentsForIdentities: async (identities) => {
          const acceptedIdentities = new Set(
            identities.map((identity) => `${identity.keyId}:${identity.userHash}`),
          );
          return restoreIntents.filter((intent) =>
            acceptedIdentities.has(`${intent.keyId}:${intent.userHash}`),
          );
        },
        recordIntent: async (intent) => {
          if (!restoreIntents.some((candidate) => candidate.requestId === intent.requestId)) {
            restoreIntents.push(intent);
          }
        },
      },
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  }, 120_000);

  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    externalApiServer.close();
    if (originalStripeSecretKey === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = originalStripeSecretKey;
    }
    await context?.cleanup();
  });

  async function mutate(path: string, input: Record<string, unknown>) {
    return mutateWithSession(path, input, sessionId);
  }

  async function mutateWithSession(
    path: string,
    input: Record<string, unknown>,
    authenticatedSessionId: string,
  ) {
    const response = await fetch(`${baseUrl}/api/trpc/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `session=${authenticatedSessionId}`,
      },
      body: JSON.stringify(input),
    });
    return response.json();
  }

  async function publicMutation(path: string, input: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}/api/trpc/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return response.json();
  }

  it("requires a session authenticated within the last 15 minutes", async () => {
    await context.db.execute(
      sql`UPDATE fitness.session
          SET created_at = now() - interval '16 minutes'
          WHERE id = ${sessionId}`,
    );

    const result = await mutate("accountErasure.prepare", {
      confirmation: "DELETE",
    });

    expect(result.error.data.code).toBe("PRECONDITION_FAILED");
    expect(result.error.message).toContain("sign in again");
    await context.db.execute(
      sql`UPDATE fitness.session SET created_at = now() WHERE id = ${sessionId}`,
    );
  });

  it("requires explicit typed confirmation", async () => {
    const result = await mutate("accountErasure.prepare", {
      confirmation: "delete",
    });
    expect(result.error.data.code).toBe("BAD_REQUEST");
  });

  it("rejects a client-supplied analytics identity", async () => {
    const result = await mutate("accountErasure.prepare", {
      confirmation: "DELETE",
      posthogDistinctId: "another-users-distinct-id",
    });
    expect(result.error.data.code).toBe("BAD_REQUEST");
  });

  it("returns an actionable precondition error before activating an unsafe provider request", async () => {
    const prepared = await mutateWithSession(
      "accountErasure.prepare",
      { confirmation: "DELETE" },
      guardedSessionId,
    );
    const result = await publicMutation("accountErasure.confirm", {
      preparationToken: prepared.result.data.preparationToken,
    });

    expect(result.error.data.code).toBe("PRECONDITION_FAILED");
    expect(result.error.message).toBe(
      "Disconnect Dofek in the COROS app under Profile > Settings > 3rd Party Apps > Data Sync, then disconnect COROS in Dofek before deleting your account.",
    );
    const state = await context.db.execute(
      sql`SELECT
            (SELECT count(*)::int
             FROM fitness.session
             WHERE id = ${guardedSessionId}) AS sessions,
            (SELECT count(*)::int
             FROM fitness.account_erasure_request
             WHERE user_id = ${guardedAccountErasureUserId}::uuid) AS requests`,
    );
    expect(state).toEqual([{ requests: 0, sessions: 1 }]);
  });

  it("rejects stolen and expired preparation capabilities without revoking the session", async () => {
    const stolen = await publicMutation("accountErasure.confirm", {
      preparationToken: "x".repeat(43),
    });
    expect(stolen.error.data.code).toBe("NOT_FOUND");

    const prepared = await mutate("accountErasure.prepare", {
      confirmation: "DELETE",
    });
    await context.db.execute(
      sql`UPDATE fitness.account_erasure_preparation
          SET expires_at = now() - interval '1 second'
          WHERE user_id = ${accountErasureUserId}::uuid`,
    );
    await expect(deleteExpiredAccountErasurePreparations(context.db)).resolves.toBe(1);
    const expired = await publicMutation("accountErasure.confirm", {
      preparationToken: prepared.result.data.preparationToken,
    });
    expect(expired.error.data.code).toBe("NOT_FOUND");

    const sessions = await context.db.execute(
      sql`SELECT count(*)::int AS count
          FROM fitness.session
          WHERE user_id = ${accountErasureUserId}::uuid`,
    );
    expect(sessions).toEqual([{ count: 1 }]);
  });

  it("serializes concurrent preparations and accepts only the newest capability", async () => {
    const [first, second] = await Promise.all([
      mutate("accountErasure.prepare", { confirmation: "DELETE" }),
      mutate("accountErasure.prepare", { confirmation: "DELETE" }),
    ]);
    const tokens = [first.result.data.preparationToken, second.result.data.preparationToken];
    const rows = await context.db.execute(
      sql`SELECT preparation_token_hash
          FROM fitness.account_erasure_preparation
          WHERE user_id = ${accountErasureUserId}::uuid`,
    );
    const activeHash = rows[0]?.preparation_token_hash;
    const activeToken = tokens.find(
      (token) => createHash("sha256").update(token).digest("hex") === activeHash,
    );
    const staleToken = tokens.find((token) => token !== activeToken);
    expect(activeToken).toBeDefined();
    expect(staleToken).toBeDefined();

    const rejected = await publicMutation("accountErasure.confirm", {
      preparationToken: staleToken,
    });
    expect(rejected.error.data.code).toBe("NOT_FOUND");
  });

  it("recovers the same status credential after activation commits but its response is lost", async () => {
    stripeCustomerDiscoveryRequests = 0;
    const prepared = await mutate("accountErasure.prepare", {
      confirmation: "DELETE",
    });
    expect(prepared.result.data).toEqual({
      expiresAt: expect.any(String),
      preparationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    const preparationToken = prepared.result.data.preparationToken;
    const persisted = await context.db.execute(
      sql`SELECT preparation_token_hash
          FROM fitness.account_erasure_preparation
          WHERE user_id = ${accountErasureUserId}::uuid`,
    );
    expect(persisted).toEqual([
      {
        preparation_token_hash: createHash("sha256").update(preparationToken).digest("hex"),
      },
    ]);
    expect(JSON.stringify(persisted)).not.toContain(preparationToken);

    const [lostResponse, concurrentResponse] = await Promise.all([
      publicMutation("accountErasure.confirm", { preparationToken }),
      publicMutation("accountErasure.confirm", { preparationToken }),
    ]);
    expect(concurrentResponse.result.data).toEqual(lostResponse.result.data);
    expect(stripeCustomerDiscoveryRequests).toBeGreaterThan(0);
    const durableRows = await context.db.execute(
      sql`SELECT
            (SELECT count(*)::int
             FROM fitness.account_erasure_request
             WHERE user_hash = (
               SELECT user_hash
               FROM fitness.account_erasure_request
               WHERE id = ${lostResponse.result.data.requestId}::uuid
             )) AS requests,
            (SELECT count(*)::int
             FROM fitness.account_erasure_outbox
             WHERE request_id = ${lostResponse.result.data.requestId}::uuid) AS outbox,
            (SELECT count(*)::int
             FROM fitness.account_erasure_checkpoint
             WHERE request_id = ${lostResponse.result.data.requestId}::uuid
               AND phase = 'stripe_erasure') AS stripe_checkpoint`,
    );
    expect(durableRows).toEqual([{ outbox: 1, requests: 1, stripe_checkpoint: 1 }]);
    expect(restoreIntents).toHaveLength(1);
    const discoveryRequestsAfterAcceptance = stripeCustomerDiscoveryRequests;

    const recoveredResponse = await publicMutation("accountErasure.confirm", {
      preparationToken,
    });
    const initiation = recoveredResponse.result.data;
    expect(stripeCustomerDiscoveryRequests).toBe(discoveryRequestsAfterAcceptance);

    expect(initiation).toEqual({
      retentionUntil: expect.any(String),
      replayRetainedUntil: expect.any(String),
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      statusToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
    expect(lostResponse.result.data).toEqual(initiation);

    const rejectedWrite = await mutate("settings.set", {
      key: "unitSystem",
      value: "metric",
    });
    expect(rejectedWrite.error.data.code).toBe("UNAUTHORIZED");

    const status = await publicMutation("accountErasure.status", {
      statusToken: initiation.statusToken,
    });
    expect(status.result.data).toEqual(
      expect.objectContaining({
        id: initiation.requestId,
        status: "pending",
      }),
    );

    const deniedStatus = await publicMutation("accountErasure.status", {
      statusToken: "w".repeat(43),
    });
    expect(deniedStatus.error.data.code).toBe("NOT_FOUND");

    for (const statusToken of ["w".repeat(42), "w".repeat(44), `${"w".repeat(42)}+`]) {
      const malformedStatus = await publicMutation("accountErasure.status", {
        statusToken,
      });
      expect(malformedStatus.error.data.code).toBe("BAD_REQUEST");
    }
  });
});
