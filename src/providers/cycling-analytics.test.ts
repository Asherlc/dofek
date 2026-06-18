import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CyclingAnalyticsProvider } from "./cycling-analytics.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  reconcileProviderActivityAbsence: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      fn: () => Promise<{ recordCount: number; result: unknown }>,
    ) => {
      const { result } = await fn();
      return result;
    },
  ),
}));

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "cycling_analytics"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: null,
  })),
  saveTokens: vi.fn(async () => {}),
  deleteTokens: vi.fn(async () => {}),
}));

vi.mock("../db/provider-activity-absence.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/provider-activity-absence.ts")>();
  return {
    ...original,
    reconcileProviderActivityAbsence: providerActivityAbsenceMocks.reconcileProviderActivityAbsence,
  };
});

describe("CyclingAnalyticsProvider — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    providerActivityAbsenceMocks.reconcileProviderActivityAbsence.mockClear();
  });

  it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'cycling_analytics'", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new CyclingAnalyticsProvider(mockFetch);
    const setup = provider.authSetup();

    const err = await setup.exchangeCode?.("any-code").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("cycling_analytics");
      expect(err.statusCode).toBe(429);
    }
  });

  it("skips rides after the sync window end", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/me/rides")) {
        if (url.includes("page=1")) {
          return Response.json({ rides: [] });
        }
        return Response.json({
          rides: [
            {
              id: 1,
              title: "In window",
              date: "2026-03-01T08:00:00Z",
              duration: 3600,
            },
            {
              id: 2,
              title: "After window",
              date: "2026-03-03T08:00:00Z",
              duration: 3600,
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const { db, spies } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(spies.values).toHaveBeenCalledWith(expect.objectContaining({ externalId: "1" }));
    expect(spies.values).not.toHaveBeenCalledWith(expect.objectContaining({ externalId: "2" }));
    expect(providerActivityAbsenceMocks.reconcileProviderActivityAbsence).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(["1"]),
      }),
    );
  });

  it("rejects malformed ride dates at the API boundary", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json({
        rides: [
          {
            id: 1,
            title: "Bad date",
            date: "not-a-date",
            duration: 3600,
          },
        ],
      });

    const { db } = createMockDatabase();
    const result = await new CyclingAnalyticsProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("activity:");
  });
});
