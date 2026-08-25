import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  DeveloperApiProblemSchema,
  DeveloperClientSecretSchema,
} from "@dofek/auth/developer-clients";
import { sql } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { initiateAccountErasure } from "../../../../src/db/account-erasure.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { DeveloperClientRepository } from "../repositories/developer-client-repository.ts";
import { createDeveloperClientsRouter } from "./developer-clients.ts";
import { createExternalWriteApiRouter } from "./external-write-api.ts";
import { hashSecret } from "./external-write-api-primitives.ts";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ADMIN_USER_ID = "00000000-0000-4000-8000-000000000099";
const ERASURE_USER_ID = "00000000-0000-4000-8000-000000000022";
const countRowSchema = z.object({ count: z.coerce.number() });
const developerClientCredentialRowSchema = z.object({
  owner_user_id: z.string(),
  secret_hash: z.string(),
});
const grantTokenRowSchema = z.object({
  access_token_hash: z.string(),
  expires_at: timestampStringSchema,
});
const grantTokenHashRowSchema = z.object({ access_token_hash: z.string() });
const reissueResponseSchema = z.object({
  accessToken: z.string(),
  externalSubject: z.string(),
  grantId: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number(),
  scope: z.string(),
});

function pkceChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}

async function createGrant(
  testContext: TestContext,
  options: {
    clientId: string;
    clientSecret: string;
    namespace: string;
    subject: string;
    userId?: string;
    revoked?: boolean;
    expired?: boolean;
  },
) {
  const userId = options.userId ?? randomUUID();
  const opaqueSubject = `opaque-${options.clientId}`;
  const grantId = randomUUID();
  const oldToken = `old-token-${grantId}`;
  await testContext.db.execute(
    sql`INSERT INTO fitness.user_profile (id, name, email, is_admin)
        VALUES (${userId}, ${options.clientId}, NULL, false)
        ON CONFLICT (id) DO NOTHING`,
  );
  await testContext.db.execute(sql`
    INSERT INTO fitness.external_client
      (client_id, owner_user_id, name, secret_hash, scopes)
    VALUES
      (${options.clientId}, ${userId}::uuid, ${options.clientId}, ${hashSecret(options.clientSecret)}, ARRAY['nutrition:write'])
  `);
  await testContext.db.execute(
    sql`INSERT INTO fitness.external_identity_link (namespace, subject, user_id, opaque_subject)
        VALUES (${options.namespace}, ${options.subject}, ${userId}, ${opaqueSubject})`,
  );
  await testContext.db.execute(
    sql`INSERT INTO fitness.external_grant
        (grant_id, client_id, user_id, namespace, subject, opaque_subject, access_token_hash, scopes, expires_at, revoked_at)
        VALUES (${grantId}::uuid, ${options.clientId}, ${userId}, ${options.namespace}, ${options.subject}, ${opaqueSubject}, ${hashSecret(oldToken)}, ARRAY['nutrition:write'], ${options.expired ? sql`NOW() - INTERVAL '1 minute'` : sql`NOW() + INTERVAL '15 minutes'`}, ${options.revoked ? sql`NOW()` : null})`,
  );
  return {
    authorization: `Bearer ${options.clientId}.${options.clientSecret}`,
    grantId,
    oldToken,
    userId,
  };
}

describe.sequential("external write API network contract", () => {
  let testContext: TestContext;
  let server: Server;
  let baseUrl: string;
  let developerClientIp = 80;
  let linkStartRateLimitIp = 90;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email, is_admin)
          VALUES (${USER_ID}, 'External API Test', 'external-api@example.test', true)
          ON CONFLICT (id) DO UPDATE SET is_admin = true`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email, is_admin)
          VALUES (${ADMIN_USER_ID}, 'External API Admin Test', NULL, true)
          ON CONFLICT (id) DO UPDATE SET is_admin = true`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email, is_admin)
          VALUES (${ERASURE_USER_ID}, 'External API Erasure Test', 'external-api-erasure@example.test', true)
          ON CONFLICT (id) DO UPDATE SET is_admin = true`,
    );
    await testContext.db.execute(sql`DELETE FROM fitness.external_erasure_ack`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_idempotency_receipt`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_grant`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_identity_link`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_link`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_client`);
    const app = express();
    app.set("trust proxy", 1);
    app.use(
      "/api/developer/clients",
      createDeveloperClientsRouter({
        db: testContext.db,
        repository: new DeveloperClientRepository(testContext.db),
      }),
    );
    app.use("/api/external/v1", createExternalWriteApiRouter({ db: testContext.db }));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        baseUrl = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
        resolve();
      });
    });
  }, 120_000);

  beforeEach(async () => {
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email, is_admin)
          VALUES (${USER_ID}, 'External API Test', 'external-api@example.test', true)
          ON CONFLICT (id) DO UPDATE SET is_admin = true`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email, is_admin)
          VALUES (${ERASURE_USER_ID}, 'External API Erasure Test', 'external-api-erasure@example.test', true)
          ON CONFLICT (id) DO UPDATE SET is_admin = true`,
    );
    await testContext.db.execute(
      sql`DELETE FROM fitness.account_erasure_identity_fence
          WHERE request_id IN (
            SELECT id
            FROM fitness.account_erasure_request
            WHERE user_id IN (${USER_ID}::uuid, ${ERASURE_USER_ID}::uuid)
          )`,
    );
    await testContext.db.execute(
      sql`DELETE FROM fitness.account_erasure_preparation
          WHERE user_id IN (${USER_ID}::uuid, ${ERASURE_USER_ID}::uuid)`,
    );
    await testContext.db.execute(
      sql`DELETE FROM fitness.account_erasure_request
          WHERE user_id IN (${USER_ID}::uuid, ${ERASURE_USER_ID}::uuid)`,
    );
    await testContext.db.execute(sql`DELETE FROM fitness.external_erasure_ack`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_idempotency_receipt`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_grant`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_identity_link`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_link`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_client`);
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await testContext?.cleanup();
  });

  async function createDeveloperClient(
    name: string,
    redirectUri = "https://slack.example.test/dofek/callback",
  ) {
    developerClientIp += 1;
    const session = await createSession(testContext.db, ADMIN_USER_ID);
    const response = await fetch(`${baseUrl}/api/developer/clients`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.sessionId}`,
        "Content-Type": "application/json",
        "X-Forwarded-For": `198.51.100.${developerClientIp}`,
      },
      body: JSON.stringify({
        name,
        redirectUris: [redirectUri],
        scopes: ["nutrition:write"],
      }),
    });
    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(201);
    return {
      client: DeveloperClientSecretSchema.parse(JSON.parse(responseBody)),
      sessionId: session.sessionId,
    };
  }

  async function countExternalLinks(): Promise<number> {
    const rows = await executeWithSchema(
      testContext.db,
      countRowSchema,
      sql`
      SELECT COUNT(*)::integer AS count FROM fitness.external_link
    `,
    );
    return rows[0]?.count ?? 0;
  }

  function startLink(input: {
    authorization: string;
    codeVerifier: string;
    ip?: string;
    redirectUri: string;
  }): Promise<Response> {
    return fetch(`${baseUrl}/api/external/v1/link/start`, {
      method: "POST",
      headers: {
        Authorization: input.authorization,
        "Content-Type": "application/json",
        "X-Forwarded-For": input.ip ?? "198.51.100.81",
      },
      body: JSON.stringify({
        redirectUri: input.redirectUri,
        codeChallenge: pkceChallenge(input.codeVerifier),
        requestedScopes: ["nutrition:write"],
        state: "state-value",
      }),
    });
  }

  it("provisions an owner client through the authenticated developer API", async () => {
    const created = await createDeveloperClient("contract-test");
    const rows = await executeWithSchema(
      testContext.db,
      developerClientCredentialRowSchema,
      sql`
      SELECT owner_user_id, secret_hash
      FROM fitness.external_client
      WHERE client_id = ${created.client.client.clientId}
    `,
    );
    expect(rows).toEqual([
      {
        owner_user_id: ADMIN_USER_ID,
        secret_hash: hashSecret(created.client.clientSecret),
      },
    ]);
    expect(rows[0]?.secret_hash).not.toBe(created.client.clientSecret);
  });

  it("covers exact redirect linking, one-time exchange, nutrition write, status, and revocation", async () => {
    const created = await createDeveloperClient("lifecycle-test");
    const provisioned = created.client;

    const rotateResponse = await fetch(
      `${baseUrl}/api/developer/clients/${provisioned.client.clientId}/rotate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${created.sessionId}`,
          "X-Forwarded-For": "198.51.100.82",
        },
      },
    );
    expect(rotateResponse.status).toBe(200);
    const rotated = DeveloperClientSecretSchema.parse(await rotateResponse.json());
    expect(rotated.clientSecret).not.toBe(provisioned.clientSecret);

    const codeVerifier = "a".repeat(43);
    const authorization = `Bearer ${provisioned.client.clientId}.${rotated.clientSecret}`;
    const rejected = await startLink({
      authorization,
      codeVerifier,
      redirectUri: "https://unregistered.example/callback",
    });
    expect(rejected.status).toBe(422);
    expect(rejected.headers.get("location")).toBeNull();
    expect(await countExternalLinks()).toBe(0);

    const nonCanonical = await startLink({
      authorization,
      codeVerifier,
      redirectUri: "https://slack.example.test:443/dofek/callback",
    });
    expect(nonCanonical.status).toBe(422);
    expect(nonCanonical.headers.get("location")).toBeNull();
    expect(await countExternalLinks()).toBe(0);

    const startResponse = await startLink({
      authorization,
      codeVerifier,
      redirectUri: provisioned.client.redirectUris[0] ?? "",
    });
    expect(startResponse.status).toBe(200);
    const started = z.object({ linkId: z.string().uuid() }).parse(await startResponse.json());

    const authorizePage = await fetch(
      `${baseUrl}/api/external/v1/link/authorize?linkId=${started.linkId}`,
      { headers: { Authorization: `Bearer ${created.sessionId}` } },
    );
    expect(authorizePage.status).toBe(200);
    const authorizeHtml = await authorizePage.text();
    expect(authorizeHtml).toContain("Approve");
    const csrfToken = authorizeHtml.match(/name="csrfToken" value="([^"]+)"/)?.[1];
    expect(csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const csrfFailure = await fetch(`${baseUrl}/api/external/v1/link/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${created.sessionId}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ linkId: started.linkId, approved: "true" }),
    });
    expect(csrfFailure.status).toBe(422);

    const authorizeResponse = await fetch(`${baseUrl}/api/external/v1/link/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${created.sessionId}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        linkId: started.linkId,
        approved: "true",
        csrfToken: csrfToken ?? "",
      }),
    });
    expect(authorizeResponse.status).toBe(303);
    const location = new URL(authorizeResponse.headers.get("location") ?? "");
    expect(location.searchParams.get("state")).toBe("state-value");

    const exchangeResponse = await fetch(`${baseUrl}/api/external/v1/link/exchange`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        linkId: started.linkId,
        code: location.searchParams.get("code"),
        codeVerifier,
        externalSubject: { namespace: "slack", subject: "lifecycle-user" },
      }),
    });
    expect(exchangeResponse.status).toBe(200);
    const exchanged = z
      .object({ accessToken: z.string(), grantId: z.string().uuid() })
      .parse(await exchangeResponse.json());

    const statusResponse = await fetch(`${baseUrl}/api/external/v1/link/status`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ namespace: "slack", subject: "lifecycle-user" }),
    });
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ grantId: exchanged.grantId });

    const nutritionResponse = await fetch(`${baseUrl}/api/external/v1/nutrition/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${exchanged.accessToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "lifecycle-nutrition-request",
      },
      body: JSON.stringify({
        entries: [
          {
            date: "2026-08-24",
            meal: "lunch",
            foodName: "Lifecycle lunch",
            externalId: "lifecycle-lunch",
            nutrients: { calories: 500 },
          },
        ],
      }),
    });
    expect(nutritionResponse.status).toBe(200);
    expect(await nutritionResponse.json()).toMatchObject({
      entries: [{ externalId: "lifecycle-lunch" }],
    });

    const ackResponse = await fetch(`${baseUrl}/api/external/v1/erasure/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${exchanged.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ eventId: "lifecycle-event", result: "completed" }),
    });
    expect(ackResponse.status).toBe(200);
    expect(await ackResponse.json()).toEqual({ accepted: true });

    const revokeResponse = await fetch(
      `${baseUrl}/api/developer/clients/${provisioned.client.clientId}/revoke`,
      { method: "POST", headers: { Authorization: `Bearer ${created.sessionId}` } },
    );
    expect(revokeResponse.status).toBe(200);
    expect(await revokeResponse.json()).toEqual({ revoked: true });
  });

  it("returns a structured 429 on the sixty-first authenticated link start per IP", async () => {
    const created = await createDeveloperClient("link-rate-limit-test");
    const authorization = `Bearer ${created.client.client.clientId}.${created.client.clientSecret}`;
    linkStartRateLimitIp += 1;
    const ip = `198.51.100.${linkStartRateLimitIp}`;
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const response = await startLink({
        authorization,
        codeVerifier: "b".repeat(43),
        ip,
        redirectUri: created.client.client.redirectUris[0] ?? "",
      });
      statuses.push(response.status);
      if (attempt === 60) {
        expect(DeveloperApiProblemSchema.parse(await response.json())).toMatchObject({
          code: "RATE_LIMITED",
          status: 429,
        });
      }
    }
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it("counts rejected client authentication toward the link-start limit", async () => {
    const created = await createDeveloperClient("rejected-link-rate-limit-test");
    const authorization = `Bearer ${created.client.client.clientId}.${created.client.clientSecret}`;
    linkStartRateLimitIp += 1;
    const ip = `198.51.100.${linkStartRateLimitIp}`;
    const rejected = await startLink({
      authorization: "Bearer ext_invalid.invalid-secret",
      codeVerifier: "c".repeat(43),
      ip,
      redirectUri: created.client.client.redirectUris[0] ?? "",
    });
    expect(rejected.status).toBe(401);

    for (let attempt = 0; attempt < 59; attempt += 1) {
      const response = await startLink({
        authorization,
        codeVerifier: "c".repeat(43),
        ip,
        redirectUri: created.client.client.redirectUris[0] ?? "",
      });
      expect(response.status).toBe(200);
    }
    const limited = await startLink({
      authorization,
      codeVerifier: "c".repeat(43),
      ip,
      redirectUri: created.client.client.redirectUris[0] ?? "",
    });
    expect(limited.status).toBe(429);
    expect(DeveloperApiProblemSchema.parse(await limited.json())).toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
  });

  it("reissues an expired token on the same grant and rotates the stored hash", async () => {
    const grant = await createGrant(testContext, {
      clientId: "reissue-client",
      clientSecret: "client-secret",
      namespace: "slack",
      subject: "team-user-1",
      expired: true,
    });
    const response = await fetch(`${baseUrl}/api/external/v1/link/reissue`, {
      method: "POST",
      headers: { Authorization: grant.authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "slack", subject: "team-user-1" }),
    });
    expect(response.status).toBe(200);
    const body = reissueResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      externalSubject: "opaque-reissue-client",
      grantId: grant.grantId,
      tokenType: "Bearer",
      expiresIn: 900,
      scope: "nutrition:write",
    });
    expect(body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await executeWithSchema(
      testContext.db,
      grantTokenRowSchema,
      sql`SELECT access_token_hash, expires_at FROM fitness.external_grant WHERE grant_id = ${grant.grantId}::uuid`,
    );
    expect(rows[0]?.access_token_hash).toBe(hashSecret(body.accessToken));
    expect(rows[0]?.access_token_hash).not.toBe(hashSecret(grant.oldToken));
    expect(new Date(String(rows[0]?.expires_at)).getTime()).toBeGreaterThan(Date.now());

    const oldTokenResponse = await fetch(`${baseUrl}/api/external/v1/nutrition/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${grant.oldToken}`,
        "Content-Type": "application/json",
        "Idempotency-Key": "old-token-request-key",
      },
      body: "{}",
    });
    expect(oldTokenResponse.status).toBe(401);
  });

  it("allows only one concurrent token reissue to replace the stored grant token", async () => {
    const grant = await createGrant(testContext, {
      clientId: "concurrent-reissue-client",
      clientSecret: "client-secret",
      namespace: "slack",
      subject: "concurrent-reissue-subject",
      expired: true,
    });
    let releaseAccountLock = () => {};
    const accountLockRelease = new Promise<void>((resolve) => {
      releaseAccountLock = resolve;
    });
    let reportAccountLockHeld = () => {};
    const accountLockHeld = new Promise<void>((resolve) => {
      reportAccountLockHeld = resolve;
    });
    const blocker = testContext.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${grant.userId}::text, 0))`,
      );
      reportAccountLockHeld();
      await accountLockRelease;
    });
    await accountLockHeld;

    const reissue = () =>
      fetch(`${baseUrl}/api/external/v1/link/reissue`, {
        method: "POST",
        headers: { Authorization: grant.authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ namespace: "slack", subject: "concurrent-reissue-subject" }),
      });
    const pendingResponses = [reissue(), reissue()];
    await expect
      .poll(
        async () => {
          const rows = await executeWithSchema(
            testContext.db,
            countRowSchema,
            sql`SELECT COUNT(*)::int AS count
                FROM pg_stat_activity
                WHERE pid <> pg_backend_pid()
                  AND wait_event_type = 'Lock'
                  AND query LIKE '%lock_and_reject_account_erasure_write%'`,
          );
          return rows[0]?.count ?? 0;
        },
        { timeout: 5_000 },
      )
      .toBe(2);
    releaseAccountLock();
    await blocker;

    const responses = await Promise.all(pendingResponses);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const successfulResponse = responses.find((response) => response.status === 200);
    const conflictingResponse = responses.find((response) => response.status === 409);
    expect(successfulResponse).toBeDefined();
    expect(conflictingResponse).toBeDefined();
    const successfulBody = reissueResponseSchema.parse(await successfulResponse?.json());
    expect(DeveloperApiProblemSchema.parse(await conflictingResponse?.json())).toMatchObject({
      code: "REQUEST_IN_PROGRESS",
      status: 409,
    });
    const tokenRows = await executeWithSchema(
      testContext.db,
      grantTokenHashRowSchema,
      sql`SELECT access_token_hash
          FROM fitness.external_grant
          WHERE grant_id = ${grant.grantId}::uuid`,
    );
    expect(tokenRows).toEqual([{ access_token_hash: hashSecret(successfulBody.accessToken) }]);
  });

  it("writes nutrition entries and enforces request validation and idempotency", async () => {
    const grant = await createGrant(testContext, {
      clientId: "nutrition-client",
      clientSecret: "nutrition-secret",
      namespace: "slack",
      subject: "nutrition-subject",
    });
    const entry = {
      date: "2026-08-20",
      meal: "lunch",
      foodName: "Test lunch",
      externalId: "nutrition-entry-1",
      nutrients: { calories: 500 },
    };
    const request = (body: unknown, key = "nutrition-request-key") =>
      fetch(`${baseUrl}/api/external/v1/nutrition/entries`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${grant.oldToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(body),
      });

    const response = await request({ entries: [entry] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ entries: [{ externalId: entry.externalId }] });

    const replay = await request({ entries: [entry] });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ entries: [{ externalId: entry.externalId }] });

    const reused = await request(
      { entries: [{ ...entry, foodName: "Different lunch" }] },
      "nutrition-request-key",
    );
    expect(reused.status).toBe(409);
    expect((await reused.json()).code).toBe("IDEMPOTENCY_KEY_REUSED");

    const missingKey = await request({ entries: [entry] }, "short");
    expect(missingKey.status).toBe(422);

    const mixedDates = await request(
      { entries: [entry, { ...entry, externalId: "nutrition-entry-2", date: "2026-08-21" }] },
      "nutrition-mixed-date-key",
    );
    expect(mixedDates.status).toBe(422);
  });

  it("rolls back nutrition writes when completing the idempotency receipt fails", async () => {
    const grant = await createGrant(testContext, {
      clientId: "atomic-idempotency-client",
      clientSecret: "atomic-idempotency-secret",
      namespace: "slack",
      subject: "atomic-idempotency-subject",
    });
    await testContext.db.execute(sql`
      CREATE OR REPLACE FUNCTION fitness.fail_external_receipt_completion_for_test()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.status = 'completed' THEN
          RAISE EXCEPTION 'forced receipt completion failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await testContext.db.execute(sql`
      CREATE TRIGGER fail_external_receipt_completion_for_test
      BEFORE UPDATE OF status ON fitness.external_idempotency_receipt
      FOR EACH ROW
      EXECUTE FUNCTION fitness.fail_external_receipt_completion_for_test()
    `);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/external/v1/nutrition/entries`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${grant.oldToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "atomic-idempotency-request-key",
        },
        body: JSON.stringify({
          entries: [
            {
              date: "2026-08-20",
              meal: "lunch",
              foodName: "Atomic lunch",
              externalId: "atomic-idempotency-entry",
              nutrients: { calories: 500 },
            },
          ],
        }),
      });
    } finally {
      await testContext.db.execute(
        sql`DROP TRIGGER fail_external_receipt_completion_for_test ON fitness.external_idempotency_receipt`,
      );
      await testContext.db.execute(
        sql`DROP FUNCTION fitness.fail_external_receipt_completion_for_test()`,
      );
    }

    expect(response.status).toBe(503);
    const counts = await executeWithSchema(
      testContext.db,
      z.object({ food_count: z.coerce.number(), receipt_count: z.coerce.number() }),
      sql`SELECT
            (SELECT COUNT(*)::int
             FROM fitness.food_entry
             WHERE user_id = ${grant.userId}::uuid
               AND external_id = 'atomic-idempotency-entry') AS food_count,
            (SELECT COUNT(*)::int
             FROM fitness.external_idempotency_receipt
             WHERE grant_id = ${grant.grantId}::uuid
               AND idempotency_key = 'atomic-idempotency-request-key') AS receipt_count`,
    );
    expect(counts).toEqual([{ food_count: 0, receipt_count: 0 }]);
  });

  it("returns the validation error envelope for an invalid subject", async () => {
    const grant = await createGrant(testContext, {
      clientId: "validation-client",
      clientSecret: "validation-secret",
      namespace: "slack",
      subject: "validation-subject",
    });
    const response = await fetch(`${baseUrl}/api/external/v1/link/reissue`, {
      method: "POST",
      headers: { Authorization: grant.authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "" }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe("VALIDATION_ERROR");
  });

  it("does not reissue a subject owned by another client", async () => {
    await createGrant(testContext, {
      clientId: "owner-client",
      clientSecret: "owner-secret",
      namespace: "slack",
      subject: "team-user-2",
    });
    await createGrant(testContext, {
      clientId: "other-client",
      clientSecret: "other-secret",
      namespace: "slack",
      subject: "different-subject",
    });
    const response = await fetch(`${baseUrl}/api/external/v1/link/reissue`, {
      method: "POST",
      headers: {
        Authorization: "Bearer other-client.other-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ namespace: "slack", subject: "team-user-2" }),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  it.each([
    ["missing", "missing-subject", false],
    ["revoked", "revoked-subject", true],
  ] as const)("returns NOT_FOUND for a %s grant", async (_label, subject, revoked) => {
    const grant = await createGrant(testContext, {
      clientId: `reissue-${subject}`,
      clientSecret: "client-secret",
      namespace: "slack",
      subject,
      revoked,
    });
    if (!revoked) {
      await testContext.db.execute(
        sql`DELETE FROM fitness.external_grant WHERE grant_id = ${grant.grantId}::uuid`,
      );
    }
    const response = await fetch(`${baseUrl}/api/external/v1/link/reissue`, {
      method: "POST",
      headers: { Authorization: grant.authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "slack", subject }),
    });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  it("returns the erasure fence error without exposing account identifiers", async () => {
    const grant = await createGrant(testContext, {
      clientId: "erasure-client",
      clientSecret: "client-secret",
      namespace: "slack",
      subject: "erasure-subject",
      userId: ERASURE_USER_ID,
    });
    await initiateAccountErasure(
      testContext.db,
      ERASURE_USER_ID,
      async () => "snapshot",
      async () => undefined,
    );
    const response = await fetch(`${baseUrl}/api/external/v1/link/reissue`, {
      method: "POST",
      headers: { Authorization: grant.authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "slack", subject: "erasure-subject" }),
    });
    expect(response.status).toBe(423);
    const body = await response.json();
    expect(body.code).toBe("ACCOUNT_ERASURE_ACTIVE");
    expect(JSON.stringify(body)).not.toContain(ERASURE_USER_ID);
  });
});
