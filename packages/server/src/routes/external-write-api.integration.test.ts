import type { Server } from "node:http";
import { sql } from "drizzle-orm";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { createSession } from "../auth/session.ts";
import { createExternalWriteApiRouter } from "./external-write-api.ts";

const USER_ID = "00000000-0000-4000-8000-000000000021";

describe("external write API network contract", () => {
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
});
