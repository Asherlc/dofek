import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import type { SyncDatabase } from "../../db/index.ts";
import { PolarSyncService } from "./sync-service.ts";
import {
  sampleDailyActivity,
  sampleExercise,
  sampleNightlyRecharge,
  sampleSleep,
} from "./test-helpers.ts";

const POLAR_VALID_TOKEN: {
  providerId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scopes: null;
} = {
  providerId: "polar",
  accessToken: "polar-access-token",
  refreshToken: "polar-refresh-token",
  expiresAt: new Date("2099-01-01"),
  scopes: null,
};

function createPolarMockDb(tokenRows = [POLAR_VALID_TOKEN]): SyncDatabase {
  const mockSessionId = "mock-session-id";
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(tokenRows),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation(() => {
        const onConflictDoUpdate = vi.fn().mockImplementation(() =>
          Object.assign(Promise.resolve(), {
            returning: vi.fn().mockResolvedValue([{ id: mockSessionId }]),
          }),
        );
        return Object.assign(Promise.resolve(), {
          onConflictDoUpdate,
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          returning: vi.fn().mockResolvedValue([{ id: mockSessionId }]),
        });
      }),
    }),
    delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    execute: vi.fn().mockResolvedValue([]),
  };
}

function createSyncService(db: SyncDatabase, fetchFn: typeof globalThis.fetch): PolarSyncService {
  return new PolarSyncService({
    db,
    providerId: "polar",
    providerName: "Polar",
    fetchFn,
  });
}

type PolarDataEndpoint =
  | "/exercises"
  | "/users/sleep"
  | "/users/activities"
  | "/users/nightly-recharge";

function polarSuccessResponse(endpoint: PolarDataEndpoint): Response {
  if (endpoint === "/users/sleep") return Response.json({ nights: [] });
  if (endpoint === "/users/nightly-recharge") return Response.json({ recharges: [] });
  return Response.json([]);
}

function createPolarFetchWithEndpointStatus(
  endpointStatus: Partial<Record<PolarDataEndpoint, number>>,
): typeof globalThis.fetch {
  return async (url: string | URL | Request): Promise<Response> => {
    const urlString = String(url);
    const endpoints = [
      "/exercises",
      "/users/sleep",
      "/users/activities",
      "/users/nightly-recharge",
    ] as const;
    const endpoint = endpoints.find((path) => urlString.endsWith(path));
    if (!endpoint) return Response.json([]);
    const status = endpointStatus[endpoint] ?? 200;
    if (status === 200) return polarSuccessResponse(endpoint);
    return new Response(status === 404 ? "Not Found" : "Unauthorized", { status });
  };
}

function getAuthorizationHeader(init?: RequestInit): string {
  const headers = init?.headers;
  if (!headers) return "";

  if (headers instanceof Headers) {
    return headers.get("Authorization") ?? "";
  }

  if (Array.isArray(headers)) {
    const match = headers.find(([headerName]) => headerName.toLowerCase() === "authorization");
    return match?.[1] ?? "";
  }

  if (typeof headers === "object") {
    const upperCaseKey = Reflect.get(headers, "Authorization");
    if (typeof upperCaseKey === "string") return upperCaseKey;
    const lowerCaseKey = Reflect.get(headers, "authorization");
    if (typeof lowerCaseKey === "string") return lowerCaseKey;
  }

  return "";
}

function getPayloadProviderId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("providerId" in value)) return undefined;
  const providerId = Reflect.get(value, "providerId");
  return typeof providerId === "string" ? providerId : undefined;
}

describe("PolarSyncService.run — error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refreshes expired Polar tokens before calling API endpoints", async () => {
    process.env.POLAR_CLIENT_ID = "polar-client-id";
    process.env.POLAR_CLIENT_SECRET = "polar-client-secret";

    const tokenEndpointCalls: string[] = [];
    const activityEndpointAuthorizations: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString === "https://polarremote.com/v2/oauth2/token") {
        tokenEndpointCalls.push(urlString);
        return Response.json({
          access_token: "refreshed-polar-token",
          refresh_token: "refreshed-polar-refresh",
          expires_in: 3600,
          scope: "accesslink.read_all",
        });
      }
      if (urlString.endsWith("/exercises")) {
        const authorization = getAuthorizationHeader(init);
        activityEndpointAuthorizations.push(authorization);
        if (authorization !== "Bearer refreshed-polar-token") {
          return new Response("Unauthorized", { status: 401 });
        }
        return Response.json([]);
      }
      if (urlString.endsWith("/users/sleep")) return Response.json({ nights: [] });
      if (urlString.endsWith("/users/activities")) return Response.json([]);
      if (urlString.endsWith("/users/nightly-recharge")) return Response.json({ recharges: [] });
      return Response.json([]);
    };

    const expiredTokenRows = [
      {
        ...POLAR_VALID_TOKEN,
        accessToken: "expired-polar-token",
        refreshToken: "expired-polar-refresh",
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      },
    ];

    const service = createSyncService(createPolarMockDb(expiredTokenRows), mockFetch);
    const result = await service.run(new Date("2026-01-01"));

    expect(tokenEndpointCalls).toHaveLength(1);
    expect(activityEndpointAuthorizations).toContain("Bearer refreshed-polar-token");
    expect(result.errors).toHaveLength(0);
  });

  it("captures unauthorized exercises endpoint errors with auth guidance", async () => {
    const service = createSyncService(
      createPolarMockDb(),
      createPolarFetchWithEndpointStatus({ "/exercises": 401 }),
    );
    const result = await service.run(new Date("2026-01-01"));

    expect(
      result.errors.some((e) => e.message.includes("authorization failed while syncing exercises")),
    ).toBe(true);
  });

  it("captures 404 exercises endpoint errors with re-auth guidance", async () => {
    const service = createSyncService(
      createPolarMockDb(),
      createPolarFetchWithEndpointStatus({ "/exercises": 404 }),
    );
    const result = await service.run(new Date("2026-01-01"));

    expect(result.errors.some((e) => e.message.includes("exercises endpoint returned 404"))).toBe(
      true,
    );
  });

  it("captures unauthorized sleep endpoint errors with auth guidance", async () => {
    const service = createSyncService(
      createPolarMockDb(),
      createPolarFetchWithEndpointStatus({ "/users/sleep": 401 }),
    );
    const result = await service.run(new Date("2026-01-01"));

    expect(
      result.errors.some((e) => e.message.includes("authorization failed while syncing sleep")),
    ).toBe(true);
  });

  it("captures 404 sleep endpoint errors with re-auth guidance", async () => {
    const service = createSyncService(
      createPolarMockDb(),
      createPolarFetchWithEndpointStatus({ "/users/sleep": 404 }),
    );
    const result = await service.run(new Date("2026-01-01"));

    expect(result.errors.some((e) => e.message.includes("sleep endpoint returned 404"))).toBe(true);
  });

  it("captures unauthorized daily activity endpoint errors with auth guidance", async () => {
    const service = createSyncService(
      createPolarMockDb(),
      createPolarFetchWithEndpointStatus({ "/users/activities": 401 }),
    );
    const result = await service.run(new Date("2026-01-01"));

    expect(
      result.errors.some((e) =>
        e.message.includes("authorization failed while syncing daily activity"),
      ),
    ).toBe(true);
  });

  it("captures 404 daily activity endpoint errors with re-auth guidance", async () => {
    const service = createSyncService(
      createPolarMockDb(),
      createPolarFetchWithEndpointStatus({ "/users/activities": 404 }),
    );
    const result = await service.run(new Date("2026-01-01"));

    expect(
      result.errors.some((e) => e.message.includes("daily activity endpoint returned 404")),
    ).toBe(true);
  });

  it("returns a token error when no Polar tokens are stored", async () => {
    const service = createSyncService(
      createPolarMockDb([]),
      createPolarFetchWithEndpointStatus({}),
    );
    const result = await service.run(new Date("2026-01-01"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found for Polar");
  });

  it("syncs exercises, sleep, and daily activity on happy path", async () => {
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.endsWith("/exercises")) return Response.json([sampleExercise]);
      if (urlString.endsWith("/users/sleep")) return Response.json({ nights: [sampleSleep] });
      if (urlString.endsWith("/users/activities")) return Response.json([sampleDailyActivity]);
      if (urlString.endsWith("/users/nightly-recharge"))
        return Response.json({ recharges: [sampleNightlyRecharge] });
      return Response.json([]);
    };

    const service = createSyncService(createPolarMockDb(), mockFetch);
    const result = await service.run(new Date("2024-01-01"));

    expect(result.recordsSynced).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it("captures generic API failures for each Polar data type", async () => {
    const service = createSyncService(
      createPolarMockDb(),
      createPolarFetchWithEndpointStatus({
        "/exercises": 500,
        "/users/sleep": 500,
        "/users/activities": 500,
      }),
    );
    const result = await service.run(new Date("2026-01-01"));

    expect(result.errors.some((e) => e.message.startsWith("exercises: "))).toBe(true);
    expect(result.errors.some((e) => e.message.startsWith("sleep: "))).toBe(true);
    expect(result.errors.some((e) => e.message.startsWith("daily_activity: "))).toBe(true);
  });

  it("captures per-record insert failures for exercises, sleep, and daily metrics", async () => {
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.endsWith("/exercises")) return Response.json([sampleExercise]);
      if (urlString.endsWith("/users/sleep")) return Response.json({ nights: [sampleSleep] });
      if (urlString.endsWith("/users/activities")) return Response.json([sampleDailyActivity]);
      if (urlString.endsWith("/users/nightly-recharge"))
        return Response.json({ recharges: [sampleNightlyRecharge] });
      return Response.json([]);
    };

    const failingDb: SyncDatabase = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([POLAR_VALID_TOKEN]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockImplementation((payload: unknown) => {
          if (getPayloadProviderId(payload) === "polar") {
            return {
              onConflictDoUpdate: vi.fn().mockRejectedValue(new Error("forced insert failure")),
            };
          }
          return Object.assign(Promise.resolve(), {
            onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
            returning: vi.fn().mockResolvedValue([{ id: "activity-row-id" }]),
          });
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };

    const service = createSyncService(failingDb, mockFetch);
    const result = await service.run(new Date("2024-01-01"));

    expect(result.errors.some((e) => e.message.startsWith("Exercise "))).toBe(true);
    expect(result.errors.some((e) => e.message.startsWith("Sleep "))).toBe(true);
    expect(result.errors.some((e) => e.message.startsWith("Daily "))).toBe(true);
  });

  it("uses existing token when expired with no refresh token (Polar tokens are long-lived)", async () => {
    process.env.POLAR_CLIENT_ID = "polar-client-id";
    process.env.POLAR_CLIENT_SECRET = "polar-client-secret";

    const apiCallAuthorizations: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const urlString = String(url);
      // Should NOT call the token refresh endpoint
      if (urlString.startsWith("https://polarremote.com/")) {
        throw new Error("Should not attempt token refresh when no refresh token exists");
      }
      const authorization = getAuthorizationHeader(init);
      apiCallAuthorizations.push(authorization);
      if (urlString.endsWith("/users/sleep")) return Response.json({ nights: [] });
      if (urlString.endsWith("/users/nightly-recharge")) return Response.json({ recharges: [] });
      return Response.json([]);
    };

    const expiredNoRefreshToken = [
      {
        providerId: "polar",
        accessToken: "polar-long-lived-token",
        refreshToken: null, // No refresh token — Polar tokens are long-lived
        expiresAt: new Date("2020-01-01T00:00:00Z"), // Past expiry
        scopes: null,
      },
    ];

    const service = createSyncService(createPolarMockDb(expiredNoRefreshToken), mockFetch);
    const result = await service.run(new Date("2026-01-01"));

    // Should succeed using the existing token, not fail with "No refresh token"
    expect(result.errors).toHaveLength(0);
    expect(apiCallAuthorizations).toContain("Bearer polar-long-lived-token");
  });

  it("syncs daily activity even when nightly recharge endpoint fails", async () => {
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.endsWith("/exercises")) return Response.json([]);
      if (urlString.endsWith("/users/sleep")) return Response.json({ nights: [] });
      if (urlString.endsWith("/users/activities")) return Response.json([sampleDailyActivity]);
      if (urlString.endsWith("/users/nightly-recharge"))
        return new Response("Not Found", { status: 404 });
      return Response.json([]);
    };

    const service = createSyncService(createPolarMockDb(), mockFetch);
    const result = await service.run(new Date("2024-01-01"));

    // Daily activity should still be synced even though nightly recharge failed
    expect(result.recordsSynced).toBeGreaterThanOrEqual(1);
    // Should not have a fatal error for daily_activity
    expect(
      result.errors.some((e) => e.message.includes("daily activity endpoint returned 404")),
    ).toBe(false);
  });

  it("deletes tokens and reports revocation when refresh returns invalid_grant", async () => {
    process.env.POLAR_CLIENT_ID = "polar-client-id";
    process.env.POLAR_CLIENT_SECRET = "polar-client-secret";

    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      if (urlString.startsWith("https://polarremote.com/")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json([]);
    };

    const expiredWithRefresh = [
      {
        providerId: "polar",
        accessToken: "expired-token",
        refreshToken: "revoked-refresh-token",
        expiresAt: new Date("2020-01-01T00:00:00Z"),
        scopes: null,
      },
    ];

    const mockDb = createPolarMockDb(expiredWithRefresh);
    const service = createSyncService(mockDb, mockFetch);
    const result = await service.run(new Date("2026-01-01"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("authorization revoked");
  });

  it("deletes tokens and skips remaining sections when API returns 401", async () => {
    const calledEndpoints: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      const endpoints = [
        "/exercises",
        "/users/sleep",
        "/users/activities",
        "/users/nightly-recharge",
      ] as const;
      const endpoint = endpoints.find((path) => urlString.endsWith(path));
      if (endpoint) calledEndpoints.push(endpoint);
      if (urlString.endsWith("/exercises")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (endpoint) return polarSuccessResponse(endpoint);
      return Response.json([]);
    };

    const mockDb = createPolarMockDb();
    const service = createSyncService(mockDb, mockFetch);
    const result = await service.run(new Date("2026-01-01"));

    // Should have only attempted exercises, not sleep or activity
    expect(calledEndpoints).toEqual(["/exercises"]);
    // Should report the auth error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("authorization failed");
    // Should have deleted the stored tokens
    expect(mockDb.delete).toHaveBeenCalled();
  });

  it("deletes tokens when a later section returns 401", async () => {
    const calledEndpoints: string[] = [];
    const mockFetch: typeof globalThis.fetch = async (
      url: string | URL | Request,
    ): Promise<Response> => {
      const urlString = String(url);
      const endpoints = [
        "/exercises",
        "/users/sleep",
        "/users/activities",
        "/users/nightly-recharge",
      ] as const;
      const endpoint = endpoints.find((path) => urlString.endsWith(path));
      if (endpoint) calledEndpoints.push(endpoint);
      if (urlString.endsWith("/users/activities")) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (endpoint) return polarSuccessResponse(endpoint);
      return Response.json([]);
    };

    const mockDb = createPolarMockDb();
    const service = createSyncService(mockDb, mockFetch);
    const result = await service.run(new Date("2026-01-01"));

    // Should have attempted exercises, sleep, and activity (but not nightly-recharge after 401)
    expect(calledEndpoints).toContain("/exercises");
    expect(calledEndpoints).toContain("/users/sleep");
    expect(calledEndpoints).toContain("/users/activities");
    // Should report the auth error and delete tokens
    expect(result.errors.some((error) => error.message.includes("authorization failed"))).toBe(
      true,
    );
    expect(mockDb.delete).toHaveBeenCalled();
  });
});
