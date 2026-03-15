import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { RideWithGpsProvider, type RideWithGpsSyncResponse } from "../ride-with-gps.ts";

// ============================================================
// Coverage tests for uncovered RideWithGPS paths:
// - Lines 308-319: sync endpoint failure (client.sync() throws)
// - Lines 333-338: error during trip deletion (db.delete throws)
// ============================================================

function createSyncFailureFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    if (urlStr.includes("/api/v1/sync.json")) {
      return new Response("Service Unavailable", { status: 503 });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

function createDeleteFetch(syncResponse: RideWithGpsSyncResponse): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    if (urlStr.includes("/api/v1/sync.json")) {
      return Response.json(syncResponse);
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("RideWithGpsProvider.sync() — error paths (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.RWGPS_CLIENT_ID = "test-client-id";
    process.env.RWGPS_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "ride-with-gps", "RideWithGPS", "https://ridewithgps.com");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("handles sync endpoint failure and returns early with error (lines 308-319)", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const provider = new RideWithGpsProvider(createSyncFailureFetch());
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Sync endpoint failed");
  });

  it("handles deleted trip where activity does not exist (exercises delete path, lines 333-338)", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    // Sync response with a deleted trip that doesn't exist in the DB
    // This exercises the delete path; the DB delete won't find anything but won't error
    const syncResp: RideWithGpsSyncResponse = {
      items: [
        {
          item_type: "trip",
          item_id: 99999,
          action: "deleted",
          datetime: "2026-03-01T10:00:00Z",
        },
      ],
      meta: { rwgps_datetime: "2026-03-01T12:00:00Z" },
    };

    const provider = new RideWithGpsProvider(createDeleteFetch(syncResp));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Delete of non-existent trip should not error
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });

  it("handles removed trip action (delete branch, lines 325-339)", async () => {
    await saveTokens(ctx.db, "ride-with-gps", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user",
    });

    const syncResp: RideWithGpsSyncResponse = {
      items: [
        {
          item_type: "trip",
          item_id: 88888,
          action: "removed",
          datetime: "2026-03-01T10:00:00Z",
        },
      ],
      meta: { rwgps_datetime: "2026-03-01T12:00:00Z" },
    };

    const provider = new RideWithGpsProvider(createDeleteFetch(syncResp));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });
});

describe("RideWithGpsProvider.getUserIdentity()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns identity from user API", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";

    const mockFetch = (async (): Promise<Response> => {
      return Response.json({ user: { id: 555, email: "rider@rwgps.com", name: "Road Rider" } });
    }) as typeof globalThis.fetch;

    const provider = new RideWithGpsProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    const identity = await setup.getUserIdentity("test-token");
    expect(identity.providerAccountId).toBe("555");
    expect(identity.email).toBe("rider@rwgps.com");
    expect(identity.name).toBe("Road Rider");
  });

  it("throws on API error", async () => {
    process.env.RWGPS_CLIENT_ID = "test-id";
    process.env.RWGPS_CLIENT_SECRET = "test-secret";

    const mockFetch = (async (): Promise<Response> => {
      return new Response("Not Found", { status: 404 });
    }) as typeof globalThis.fetch;

    const provider = new RideWithGpsProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.getUserIdentity) throw new Error("getUserIdentity not defined");
    await expect(setup.getUserIdentity("bad-token")).rejects.toThrow("RWGPS user API error (404)");
  });
});
