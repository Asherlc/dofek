import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { createGarminAuthSetup } from "../providers/garmin/oauth.ts";
import type { Provider } from "../providers/types.ts";
import {
  encryptCredentialValue,
  isEncryptedCredentialValue,
} from "../security/credential-encryption.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import { revokeRemoteAccounts } from "./remote-revocation.ts";
import {
  type AccountErasureRemoteSnapshot,
  decryptAccountErasureSnapshot,
  updateAccountErasureProviderCredentials,
} from "./remote-snapshot.ts";

describe("account-erasure rotated revocation credentials (integration)", () => {
  let context: TestContext;
  const server = createIntegrationMswFixture();
  beforeAll(async () => {
    server.activate({ onUnhandledRequest: "error" });
    context = await setupTestDatabase();
  });
  afterEach(() => server.resetHandlers());
  afterAll(async () => {
    server.deactivate();
    await context?.cleanup();
  });

  async function request(providerIds = ["first", "second"]) {
    const userId = randomUUID();
    const requestId = randomUUID();
    const snapshot: AccountErasureRemoteSnapshot = {
      appleCredentials: [],
      authIdentities: [],
      externalEffects: [],
      processorEmails: [],
      posthogDistinctId: userId,
      stripe: null,
      webhooks: [],
      localIdentifiers: {
        activityIds: [],
        exportObjects: [],
        fileUploads: [],
        processingOperationIds: [],
        sessionIds: [],
        sleepSessionIds: [],
        userId,
      },
      providerConnections: providerIds.map((providerId) => ({
        disposition: "revocation_credentials",
        providerId,
        accessToken: `${providerId}-old`,
        authorizationId: randomUUID(),
        refreshToken: `${providerId}-old-refresh`,
        expiresAt: "2020-01-01T00:00:00.000Z",
        scopes: "HEALTH_EXPORT",
        providerAccountId: `${providerId}-account`,
      })),
    };
    const encrypted = await encryptCredentialValue(JSON.stringify(snapshot), {
      tableName: "fitness.account_erasure_request",
      columnName: "encrypted_remote_snapshot",
      scopeId: userId,
    });
    await context.db.execute(sql`INSERT INTO fitness.account_erasure_request
      (id, user_id, user_hash, user_hash_key_id, write_fence_hash, status_token_hash,
       encrypted_remote_snapshot, replay_retained_until, completion_deadline, status, lease_owner, lease_expires_at)
      VALUES (${requestId}::uuid, ${userId}::uuid, ${requestId}, 'test', ${requestId}, ${requestId},
        ${encrypted}, now() + interval '1 day', now() + interval '30 days', 'running', 'worker', now() + interval '5 minutes')`);
    return { requestId, userId, encrypted };
  }

  it("retries Garmin deletion from committed rotated credentials after a remote 503", async () => {
    const { requestId, userId, encrypted } = await request(["garmin"]);
    const oldClientId = process.env.GARMIN_CLIENT_ID;
    const oldClientSecret = process.env.GARMIN_CLIENT_SECRET;
    process.env.GARMIN_CLIENT_ID = "test-client";
    process.env.GARMIN_CLIENT_SECRET = "test-secret";
    let refreshes = 0;
    let deletions = 0;
    server.use(
      http.post("https://diauth.garmin.com/di-oauth2-service/oauth/token", async ({ request }) => {
        refreshes += 1;
        const body = new URLSearchParams(await request.text());
        expect(body.get("refresh_token")).toBe("garmin-old-refresh");
        return HttpResponse.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 86400,
        });
      }),
      http.delete(
        "https://apis.garmin.com/partner-gateway/rest/user/registration",
        ({ request }) => {
          deletions += 1;
          expect(request.headers.get("Authorization")).toBe("Bearer new-access");
          return new HttpResponse(null, { status: deletions === 1 ? 503 : 204 });
        },
      ),
    );
    try {
      const provider: Provider = {
        id: "garmin",
        name: "Garmin",
        validate: () => null,
        authSetup: () => createGarminAuthSetup(globalThis.fetch),
        sync: async () => ({ provider: "garmin", recordsSynced: 0, errors: [], duration: 0 }),
      };
      const persist = async (
        providerId: string,
        tokens: Parameters<typeof updateAccountErasureProviderCredentials>[4],
      ) => {
        await updateAccountErasureProviderCredentials(
          context.db,
          requestId,
          "worker",
          providerId,
          tokens,
        );
      };
      await expect(
        revokeRemoteAccounts(
          await decryptAccountErasureSnapshot(encrypted, userId),
          [provider],
          persist,
        ),
      ).rejects.toThrow("503");
      const [row] = await context.db.execute<{ encrypted_remote_snapshot: string }>(
        sql`SELECT encrypted_remote_snapshot FROM fitness.account_erasure_request WHERE id = ${requestId}::uuid`,
      );
      if (!row) throw new Error("Missing request");
      const retriedSnapshot = await decryptAccountErasureSnapshot(
        row.encrypted_remote_snapshot,
        userId,
      );
      expect(retriedSnapshot.providerConnections[0]).toMatchObject({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        providerAccountId: "garmin-account",
        scopes: "HEALTH_EXPORT",
      });
      await expect(revokeRemoteAccounts(retriedSnapshot, [provider], persist)).resolves.toEqual([
        { disposition: "remote_revoked", providerId: "garmin" },
      ]);
      expect(refreshes).toBe(1);
      expect(deletions).toBe(2);
    } finally {
      if (oldClientId === undefined) delete process.env.GARMIN_CLIENT_ID;
      else process.env.GARMIN_CLIENT_ID = oldClientId;
      if (oldClientSecret === undefined) delete process.env.GARMIN_CLIENT_SECRET;
      else process.env.GARMIN_CLIENT_SECRET = oldClientSecret;
    }
  });

  it("commits rotated tokens into the encrypted snapshot and preserves concurrent provider updates", async () => {
    const { requestId, userId } = await request();
    const authorizationId = randomUUID();
    await Promise.all(
      ["first", "second"].map((providerId) =>
        updateAccountErasureProviderCredentials(context.db, requestId, "worker", providerId, {
          accessToken: `${providerId}-rotated`,
          refreshToken: `${providerId}-rotated-refresh`,
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          scopes: "HEALTH_EXPORT",
          authorizationId,
        }),
      ),
    );
    const [row] = await context.db.execute<{ encrypted_remote_snapshot: string }>(
      sql`SELECT encrypted_remote_snapshot FROM fitness.account_erasure_request WHERE id = ${requestId}::uuid`,
    );
    if (!row) throw new Error("Missing request");
    expect(isEncryptedCredentialValue(row.encrypted_remote_snapshot)).toBe(true);
    expect(row.encrypted_remote_snapshot).not.toContain("rotated");
    const snapshot = await decryptAccountErasureSnapshot(row.encrypted_remote_snapshot, userId);
    for (const providerId of ["first", "second"]) {
      expect(
        snapshot.providerConnections.find((entry) => entry.providerId === providerId),
      ).toMatchObject({
        accessToken: `${providerId}-rotated`,
        refreshToken: `${providerId}-rotated-refresh`,
        providerAccountId: `${providerId}-account`,
        authorizationId,
      });
    }
  });

  it("rejects a stale worker before replacing revocation credentials", async () => {
    const { requestId, encrypted } = await request();
    await expect(
      updateAccountErasureProviderCredentials(context.db, requestId, "other-worker", "first", {
        accessToken: "unexpected",
        refreshToken: "unexpected",
        expiresAt: new Date(),
        scopes: null,
      }),
    ).rejects.toThrow("lease");
    const [row] = await context.db.execute<{ encrypted_remote_snapshot: string }>(
      sql`SELECT encrypted_remote_snapshot FROM fitness.account_erasure_request WHERE id = ${requestId}::uuid`,
    );
    expect(row?.encrypted_remote_snapshot).toBe(encrypted);
  });
});
