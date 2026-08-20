import { createHash, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { sql } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initiateAccountErasure } from "../../../../src/db/account-erasure.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createExternalWriteApiRouter } from "./external-write-api.ts";

const USER_ID = "00000000-0000-0000-0000-000000000001";
const ERASURE_USER_ID = USER_ID;

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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
  },
) {
  const opaqueSubject = `opaque-${options.clientId}`;
  const grantId = randomUUID();
  const oldToken = `old-token-${grantId}`;
  await testContext.db.execute(
    sql`INSERT INTO fitness.external_client (client_id, name, secret_hash, scopes)
        VALUES (${options.clientId}, ${options.clientId}, ${hash(options.clientSecret)}, ARRAY['nutrition:write'])`,
  );
  await testContext.db.execute(
    sql`INSERT INTO fitness.external_identity_link (namespace, subject, user_id, opaque_subject)
        VALUES (${options.namespace}, ${options.subject}, ${options.userId ?? USER_ID}, ${opaqueSubject})`,
  );
  await testContext.db.execute(
    sql`INSERT INTO fitness.external_grant
        (grant_id, client_id, user_id, namespace, subject, opaque_subject, access_token_hash, scopes, expires_at, revoked_at)
        VALUES (${grantId}::uuid, ${options.clientId}, ${options.userId ?? USER_ID}, ${options.namespace}, ${options.subject}, ${opaqueSubject}, ${hash(oldToken)}, ARRAY['nutrition:write'], NOW() - INTERVAL '1 minute', ${options.revoked ? sql`NOW()` : null})`,
  );
  return { authorization: `Bearer ${options.clientId}.${options.clientSecret}`, grantId, oldToken };
}

describe.sequential("external write API network contract", () => {
  let testContext: TestContext;
  let server: Server;
  let baseUrl: string;
  let sessionCookie: string;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
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
    await testContext.db.execute(sql`DELETE FROM fitness.external_erasure_ack`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_idempotency_receipt`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_grant`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_identity_link`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_link`);
    await testContext.db.execute(sql`DELETE FROM fitness.external_client`);
    const session = await createSession(testContext.db, USER_ID);
    sessionCookie = `session=${session.sessionId}`;
    const app = express();
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
    const session = await createSession(testContext.db, USER_ID);
    sessionCookie = `session=${session.sessionId}`;
  });

  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await testContext?.cleanup();
  });

  it("provisions a client without persisting the raw secret", async () => {
    const response = await fetch(`${baseUrl}/api/external/v1/clients`, {
      method: "POST",
      headers: { Cookie: sessionCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "contract-test", scopes: ["nutrition:write"] }),
    });
    expect(response.status).toBe(201);
    const body: { clientId: string; clientSecret: string } = await response.json();
    const rows = await testContext.db.execute(
      sql`SELECT secret_hash FROM fitness.external_client WHERE client_id = ${body.clientId}`,
    );
    expect(rows[0]?.secret_hash).toBeTruthy();
    expect(rows[0]?.secret_hash).not.toBe(body.clientSecret);
  });

  it("reissues an expired token on the same grant and rotates the stored hash", async () => {
    const grant = await createGrant(testContext, {
      clientId: "reissue-client",
      clientSecret: "client-secret",
      namespace: "slack",
      subject: "team-user-1",
    });
    const response = await fetch(`${baseUrl}/api/external/v1/link/reissue`, {
      method: "POST",
      headers: { Authorization: grant.authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ namespace: "slack", subject: "team-user-1" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      externalSubject: "opaque-reissue-client",
      grantId: grant.grantId,
      tokenType: "Bearer",
      expiresIn: 900,
      scope: "nutrition:write",
    });
    expect(body.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await testContext.db.execute(
      sql`SELECT access_token_hash, expires_at FROM fitness.external_grant WHERE grant_id = ${grant.grantId}::uuid`,
    );
    expect(rows[0]?.access_token_hash).toBe(hash(body.accessToken));
    expect(rows[0]?.access_token_hash).not.toBe(hash("old-token"));
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
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("INVALID_CREDENTIALS");
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
    expect(JSON.stringify(body)).not.toContain(USER_ID);
  });
});
