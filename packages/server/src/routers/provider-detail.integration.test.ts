import { closeProviderOperationFencePool } from "dofek/db/provider-operation-fence";
import { ensureProvider, loadTokens, saveTokens } from "dofek/db/tokens";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { executeWithSchema } from "../../../../src/db/typed-sql.ts";
import { failOnUnhandledExternalRequest } from "../../../../src/test/msw.ts";
import { providerDetailRouter } from "./provider-detail.ts";
import { makeMockSensorStore } from "./test-helpers.ts";

const userId = "30000000-0000-4000-8000-000000000010";
const authorizationId = "30000000-0000-4000-8000-000000000009";
const existingTokens = {
  accessToken: "expired-garmin-access",
  refreshToken: "existing-garmin-refresh",
  expiresAt: new Date("2020-01-01T00:00:00.000Z"),
  scopes: "HEALTH_EXPORT ACTIVITY_EXPORT",
  providerAccountId: "disconnect-garmin-account",
  authorizationId,
};
const externalApiServer = setupServer();

describe("provider detail operation fences (integration)", () => {
  let context: TestContext;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalClientId = process.env.GARMIN_CLIENT_ID;
  const originalClientSecret = process.env.GARMIN_CLIENT_SECRET;

  beforeAll(async () => {
    externalApiServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${userId}, 'Provider operation user')`,
    );
    process.env.DATABASE_URL = context.connectionString;
    process.env.GARMIN_CLIENT_ID = "integration-garmin-client";
    process.env.GARMIN_CLIENT_SECRET = "integration-garmin-secret";
  });

  beforeEach(async () => {
    externalApiServer.resetHandlers();
    await ensureProvider(context.db, "garmin", "Garmin", undefined, userId);
    await saveTokens(context.db, "garmin", existingTokens, userId);
  });

  afterAll(async () => {
    externalApiServer.close();
    await closeProviderOperationFencePool();
    await context?.cleanup();
    for (const [key, value] of [
      ["DATABASE_URL", originalDatabaseUrl],
      ["GARMIN_CLIENT_ID", originalClientId],
      ["GARMIN_CLIENT_SECRET", originalClientSecret],
    ] satisfies Array<[string, string | undefined]>) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function caller() {
    return providerDetailRouter.createCaller({
      db: context.db,
      userId,
      timezone: "UTC",
      sensorStore: makeMockSensorStore(),
      accountErasureRestoreLedger: {
        findIntent: async () => null,
        listIntentReferences: async () => [],
        listIntentsForIdentities: async () => [],
        recordIntent: async () => undefined,
      },
    });
  }

  it("retains the independently committed rotated authorization when disconnect revocation fails", async () => {
    let deregistrations = 0;
    externalApiServer.use(
      http.post("https://diauth.garmin.com/di-oauth2-service/oauth/token", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("grant_type")).toBe("refresh_token");
        return HttpResponse.json({
          access_token: "rotated-disconnect-access",
          refresh_token: "rotated-disconnect-refresh",
          expires_in: 86400,
        });
      }),
      http.delete("https://apis.garmin.com/partner-gateway/rest/user/registration", async () => {
        await expect(loadTokens(context.db, "garmin", userId)).resolves.toMatchObject({
          refreshToken: "rotated-disconnect-refresh",
          authorizationId,
        });
        deregistrations++;
        return HttpResponse.text("temporary outage", { status: 503 });
      }),
    );

    await expect(caller().disconnect({ providerId: "garmin" })).rejects.toThrow(
      "service unavailable (503)",
    );

    expect(deregistrations).toBe(1);
    await expect(loadTokens(context.db, "garmin", userId)).resolves.toMatchObject({
      accessToken: "rotated-disconnect-access",
      refreshToken: "rotated-disconnect-refresh",
      scopes: existingTokens.scopes,
      providerAccountId: existingTokens.providerAccountId,
      authorizationId,
    });
    const connections = await executeWithSchema(
      context.db,
      z.object({ provider_id: z.string() }),
      sql`SELECT provider_id FROM fitness.provider_connection
          WHERE user_id = ${userId} AND provider_id = 'garmin'`,
    );
    expect(connections).toEqual([{ provider_id: "garmin" }]);
  });

  it("atomically deletes provider data and queues its generation while retaining credentials", async () => {
    await context.db.execute(
      sql`INSERT INTO fitness.daily_metrics (user_id, provider_id, date, steps)
          VALUES (${userId}, 'garmin', '2026-10-20', 4000)`,
    );

    const result = await caller().deleteAllData({ providerId: "garmin", confirmation: "DELETE" });

    expect(result.success).toBe(true);
    await expect(loadTokens(context.db, "garmin", userId)).resolves.toEqual(existingTokens);
    const data = await executeWithSchema(
      context.db,
      z.object({ count: z.coerce.number() }),
      sql`SELECT COUNT(*) AS count FROM fitness.daily_metrics
          WHERE user_id = ${userId} AND provider_id = 'garmin'`,
    );
    expect(data).toEqual([{ count: 0 }]);
    const requests = await executeWithSchema(
      context.db,
      z.object({ generation: z.coerce.number(), status: z.string() }),
      sql`SELECT generation, status FROM fitness.provider_data_deletion_outbox
          WHERE event_id = ${result.operationId} AND user_id = ${userId} AND provider_id = 'garmin'`,
    );
    expect(requests).toEqual([{ generation: 1, status: "pending" }]);
  });
});
