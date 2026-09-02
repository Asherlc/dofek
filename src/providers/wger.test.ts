import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "user-1",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

interface CapturedSyncLogOutcome {
  dataType: string;
  degradations?: Array<{ kind: string; context?: unknown }>;
}

const syncLogOutcomes = vi.hoisted<{ values: CapturedSyncLogOutcome[] }>(() => ({
  values: [],
}));

afterEach(() => {
  syncLogOutcomes.values = [];
  providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
  providerActivityAbsenceMocks.upsertProviderActivity.mockClear();
});

vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(
    async (
      _db: unknown,
      _providerId: string,
      _dataType: string,
      fn: () => Promise<{
        recordCount: number;
        result: unknown;
        degradations?: Array<{ kind: string; context?: unknown }>;
      }>,
    ) => {
      const outcome = await fn();
      syncLogOutcomes.values.push({ dataType: _dataType, degradations: outcome.degradations });
      return outcome.result;
    },
  ),
}));

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(async () => "wger"),
  loadTokens: vi.fn(async () => ({
    accessToken: "valid-access-token",
    refreshToken: "valid-refresh-token",
    expiresAt: new Date("2027-01-01T00:00:00Z"),
    scopes: null,
  })),
  saveTokens: vi.fn(async () => {}),
  deleteTokens: vi.fn(async () => {}),
}));

vi.mock("../db/provider-activity-sync.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../db/provider-activity-sync.ts")>();
  return {
    ...original,
    finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

vi.mock("../db/metric-stream-writer.ts", () => ({
  writeMetricStreamBatch: vi.fn().mockResolvedValue(1),
}));

import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { deleteTokens, loadTokens, saveTokens } from "../db/tokens.ts";
import {
  authFailureReasonFromError,
  ProviderTokenRejectedError,
  RefreshTokenRevokedError,
} from "./auth-errors.ts";
import { createMockDatabase, fakeJwt } from "./test-helpers.ts";
import { parseWgerWeightEntry, parseWgerWorkoutSession, WgerProvider } from "./wger.ts";

describe("parseWgerWorkoutSession", () => {
  it("parses a session with comment", () => {
    const session = {
      id: 42,
      date: "2026-03-01",
      comment: "Leg Day",
      impression: "2",
      time_start: "09:00",
      time_end: "10:30",
    };

    const parsed = parseWgerWorkoutSession(session);
    expect(parsed.externalId).toBe("42");
    expect(parsed.activityType.canonicalType).toBe("strength");
    expect(parsed.name).toBe("Leg Day");
    expect(parsed.startedAt).toEqual(new Date("2026-03-01"));
    expect(parsed.raw.comment).toBe("Leg Day");
    expect(parsed.raw.impression).toBe("2");
    expect(parsed.raw.timeStart).toBe("09:00");
    expect(parsed.raw.timeEnd).toBe("10:30");
  });

  it("uses 'Workout' name when comment is empty", () => {
    const session = {
      id: 1,
      date: "2026-03-01",
      comment: "",
      impression: "1",
      time_start: null,
      time_end: null,
    };

    const parsed = parseWgerWorkoutSession(session);
    expect(parsed.name).toBe("Workout");
    expect(parsed.raw.timeStart).toBeNull();
    expect(parsed.raw.timeEnd).toBeNull();
  });
});

describe("parseWgerWeightEntry", () => {
  it("parses a weight entry", () => {
    const entry = {
      id: 100,
      date: "2026-03-01",
      weight: "85.5",
    };

    const parsed = parseWgerWeightEntry(entry);
    expect(parsed.externalId).toBe("100");
    expect(parsed.recordedAt).toEqual(new Date("2026-03-01"));
    expect(parsed.weightKg).toBe(85.5);
  });

  it("handles integer weight", () => {
    const parsed = parseWgerWeightEntry({ id: 1, date: "2026-03-01", weight: "80" });
    expect(parsed.weightKg).toBe(80);
  });

  it("preserves decimal precision", () => {
    const parsed = parseWgerWeightEntry({
      id: 200,
      date: "2026-03-01",
      weight: "82.123456",
    });
    expect(parsed.weightKg).toBeCloseTo(82.123456);
  });
});

describe("WgerProvider", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
  });

  it("is available without deployment OAuth credentials", () => {
    delete process.env.WGER_CLIENT_ID;
    delete process.env.WGER_CLIENT_SECRET;
    expect(new WgerProvider().validate()).toBeNull();
  });

  it("exchanges a user-minted refresh token for a rotating JWT pair", async () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 600;
    const access = fakeJwt(expiresAtSeconds);
    const mockFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      expect(String(input)).toBe("https://wger.de/api/v2/token/refresh");
      expect(init?.method).toBe("POST");
      const headers = new Headers(init?.headers);
      expect(headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");
      expect(headers.get("Accept")).toBe("application/json");
      expect(new URLSearchParams(String(init?.body)).get("refresh")).toBe("personal-refresh");
      return Response.json({ access, refresh: "rotated-refresh" });
    });
    const setup = new WgerProvider(mockFetch).authSetup();

    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.manualToken).toMatchObject({
      label: "JWT refresh token",
      instructionsUrl: "https://wger.readthedocs.io/en/latest/api/api.html#jwt-tokens",
    });
    await expect(setup.manualToken?.exchangeToken("personal-refresh")).resolves.toEqual({
      accessToken: access,
      refreshToken: "rotated-refresh",
      expiresAt: new Date(expiresAtSeconds * 1000),
      scopes: "read",
    });
  });

  it("rejects a refresh response whose access token has no JWT payload", async () => {
    const setup = new WgerProvider(async () =>
      Response.json({ access: "missing-payload", refresh: "rotated-refresh" }),
    ).authSetup();
    if (!setup.manualToken) throw new Error("expected manual token authentication");

    await expect(setup.manualToken.exchangeToken("personal-refresh")).rejects.toThrow(
      "Wger returned an access token without a JWT payload",
    );
  });

  it("preserves the parse error cause for an invalid access-token JWT payload", async () => {
    const invalidPayload = Buffer.from("not-json").toString("base64url");
    const setup = new WgerProvider(async () =>
      Response.json({
        access: `header.${invalidPayload}.signature`,
        refresh: "rotated-refresh",
      }),
    ).authSetup();
    if (!setup.manualToken) throw new Error("expected manual token authentication");

    const error = await setup.manualToken
      .exchangeToken("personal-refresh")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: "Wger returned an invalid access-token JWT payload",
    });
    expect(error instanceof Error ? error.cause : undefined).toBeInstanceOf(SyntaxError);
  });

  it.each([400, 401, 403])(
    "rejects a user-minted refresh token when Wger returns %s",
    async (status) => {
      const setup = new WgerProvider(
        async () => new Response("sensitive rejection response", { status }),
      ).authSetup();
      if (!setup.manualToken) throw new Error("expected manual token authentication");

      const error = await setup.manualToken
        .exchangeToken("rejected-refresh")
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProviderTokenRejectedError);
      expect(authFailureReasonFromError(error)).toBe("authentication_failed");
      expect(error).toMatchObject({
        message:
          "Wger rejected this token. Create a new JWT refresh token in Wger's API key settings and try again.",
      });
      expect(error instanceof Error ? error.message : "").not.toContain(
        "sensitive rejection response",
      );
    },
  );

  it("reports a safe error when Wger token refresh fails unexpectedly", async () => {
    const setup = new WgerProvider(
      async () => new Response("sensitive provider error", { status: 500 }),
    ).authSetup();
    if (!setup.manualToken) throw new Error("expected manual token authentication");

    const error = await setup.manualToken
      .exchangeToken("personal-refresh")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      message: "Wger token refresh failed (500). Try again.",
    });
    expect(error instanceof Error ? error.message : "").not.toContain("sensitive provider error");
  });

  it("sync returns error when no tokens", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    vi.mocked(loadTokens).mockResolvedValueOnce(null);
    const mockFetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("fetch should not be called when tokens are missing");
    });
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          onConflictDoUpdate: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe(
      "No tokens found for Wger. Connect Wger in Data Sources.",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refreshes when the stored access token expires at the current instant", async () => {
    const now = new Date("2026-03-01T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const access = fakeJwt(Math.floor(now.getTime() / 1000) + 600);
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "boundary-expired-access",
      refreshToken: "stored-refresh",
      expiresAt: now,
      scopes: "read",
    });
    const mockFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith("/token/refresh")) {
        return Response.json({ access, refresh: "rotated-refresh" });
      }
      return Response.json({ count: 0, next: null, previous: null, results: [] });
    });
    const { db } = createMockDatabase();

    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({ db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.errors).toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://wger.de/api/v2/token/refresh",
      expect.anything(),
    );
    expect(saveTokens).toHaveBeenCalledWith(
      db,
      "wger",
      expect.objectContaining({ accessToken: access, refreshToken: "rotated-refresh" }),
    );
  });

  it("requires reconnection when an expired access token has no refresh token", async () => {
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "expired-access",
      refreshToken: null,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "read",
    });
    const mockFetch = vi.fn<typeof globalThis.fetch>();
    const { db } = createMockDatabase();

    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({ db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.cause).toBeInstanceOf(RefreshTokenRevokedError);
    expect(authFailureReasonFromError(result.errors[0]?.cause)).toBe("refresh_token_revoked");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("deletes rejected rotated credentials and preserves the rejection cause", async () => {
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "expired-access",
      refreshToken: "rejected-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "read",
    });
    vi.mocked(deleteTokens).mockClear();
    const mockFetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("sensitive rejection response", { status: 401 }),
    );
    const { db } = createMockDatabase();

    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({ db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.errors).toHaveLength(1);
    const error = result.errors[0]?.cause;
    expect(error).toBeInstanceOf(RefreshTokenRevokedError);
    expect(authFailureReasonFromError(error)).toBe("refresh_token_revoked");
    expect(error instanceof Error ? error.cause : undefined).toBeInstanceOf(
      ProviderTokenRejectedError,
    );
    expect(deleteTokens).toHaveBeenCalledWith(db, "wger");
  });

  it("rotates an expired stored refresh token before syncing", async () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 600;
    const access = fakeJwt(expiresAtSeconds);
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "expired-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "read",
    });
    const mockFetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input).endsWith("/token/refresh")) {
        expect(new URLSearchParams(String(init?.body)).get("refresh")).toBe("stored-refresh");
        return Response.json({ access, refresh: "rotated-refresh" });
      }
      if (String(input).includes("/workoutsession/")) {
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      }
      if (String(input).includes("/weightentry/")) {
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      }
      return new Response("not found", { status: 404 });
    });
    const { db } = createMockDatabase();

    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({ db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.errors).toEqual([]);
    expect(saveTokens).toHaveBeenCalledWith(
      db,
      "wger",
      expect.objectContaining({
        accessToken: access,
        refreshToken: "rotated-refresh",
      }),
    );
  });

  it("reports a rotation persistence failure without deleting the stale token row", async () => {
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 600;
    const access = fakeJwt(expiresAtSeconds);
    const persistenceError = new Error("database unavailable while saving rotated token");
    vi.mocked(loadTokens).mockResolvedValueOnce({
      accessToken: "expired-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "read",
    });
    vi.mocked(saveTokens).mockRejectedValueOnce(persistenceError);
    vi.mocked(deleteTokens).mockClear();
    const mockFetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      expect(String(input)).toBe("https://wger.de/api/v2/token/refresh");
      return Response.json({ access, refresh: "rotated-refresh" });
    });
    const { db } = createMockDatabase();

    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({ db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toEqual([
      {
        message: persistenceError.message,
        cause: persistenceError,
      },
    ]);
    expect(deleteTokens).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it.each([
    { endpoint: "workoutsession", status: 401 },
    { endpoint: "workoutsession", status: 403 },
    { endpoint: "weightentry", status: 401 },
    { endpoint: "weightentry", status: 403 },
  ])(
    "marks a $status from the $endpoint data endpoint as requiring authentication",
    async ({ endpoint, status }) => {
      const sensitiveBody = "vendor response containing private details";
      const mockFetch: typeof globalThis.fetch = async (input) => {
        if (String(input).includes(`/${endpoint}/`)) {
          return new Response(sensitiveBody, { status });
        }
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      };
      const { db } = createMockDatabase();

      const result = await new WgerProvider(mockFetch).sync(
        new SyncRun({
          db,
          window: SyncWindow.fromDateRange({
            sinceDate: "2026-03-01",
            untilDate: "2026-03-01",
          }),
        }),
      );

      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(authFailureReasonFromError(result.errors[0]?.cause)).toBe("authentication_failed");
      expect(result.errors[0]?.message).not.toContain(sensitiveBody);
      expect(
        result.errors[0]?.cause instanceof Error ? result.errors[0].cause.message : "",
      ).not.toContain(sensitiveBody);
    },
  );

  it("reports a non-authentication Wger data error", async () => {
    const mockFetch: typeof globalThis.fetch = async (input) => {
      if (String(input).includes("/workoutsession/")) {
        return new Response("validation failed", { status: 500 });
      }
      return Response.json({ count: 0, next: null, previous: null, results: [] });
    };
    const { db } = createMockDatabase();

    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({
          sinceDate: "2026-03-01",
          untilDate: "2026-03-01",
        }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("activity: Wger API error (500): validation failed");
    expect(authFailureReasonFromError(result.errors[0]?.cause)).toBeUndefined();
  });

  it("skips workout sessions after the sync window end", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/workoutsession/")) {
        return Response.json({
          count: 2,
          next: null,
          previous: null,
          results: [
            {
              id: 10,
              date: "2026-03-01",
              comment: "In Window",
              impression: "2",
              time_start: "09:00",
              time_end: "10:00",
            },
            {
              id: 20,
              date: "2026-03-03",
              comment: "After Window",
              impression: "2",
              time_start: "09:00",
              time_end: "10:00",
            },
          ],
        });
      }
      if (url.includes("/weightentry/")) {
        return Response.json({
          count: 0,
          next: null,
          previous: null,
          results: [],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "10" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).not.toHaveBeenCalledWith(
      db,
      expect.objectContaining({ externalId: "20" }),
      expect.any(Object),
    );
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        presentExternalIds: new Set(["10"]),
      }),
    );
  });

  it("starts each sync test with a clean sync log capture", () => {
    expect(syncLogOutcomes.values).toEqual([]);
  });

  it("handles repeated workout session pagination next URLs without hanging", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    providerActivityAbsenceMocks.upsertProviderActivity.mockClear();

    const repeatedUrl =
      "https://wger.de/api/v2/workoutsession/?format=json&ordering=-date&offset=50&limit=50";
    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      callCount++;
      if (url.includes("/workoutsession/")) {
        return Response.json({
          count: 2,
          next: repeatedUrl,
          previous: null,
          results: [
            {
              id: 10,
              date: "2026-03-01",
              comment: "In Window",
              impression: "2",
              time_start: "09:00",
              time_end: "10:00",
            },
          ],
        });
      }
      if (url.includes("/weightentry/")) {
        return Response.json({
          count: 0,
          next: null,
          previous: null,
          results: [],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);
    expect(callCount).toBe(3);
    expect(syncLogOutcomes.values).toContainEqual({
      dataType: "activity",
      degradations: [
        expect.objectContaining({
          kind: "pagination_stalled",
          context: expect.objectContaining({
            cursorFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
            pagesFetched: 2,
          }),
        }),
      ],
    });
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("skips weight entries outside the bounded sync window", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";

    const { writeMetricStreamBatch } = await import("../db/metric-stream-writer.ts");

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/workoutsession/")) {
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes("/weightentry/")) {
        return Response.json({
          count: 3,
          next: null,
          previous: null,
          results: [
            { id: 1, date: "2026-03-02", weight: "80.0" },
            { id: 2, date: "2026-03-01", weight: "79.5" },
            { id: 3, date: "2026-03-03", weight: "81.0" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };
    const result = await new WgerProvider(mockFetch).sync(
      new SyncRun({
        db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-02" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);
    expect(writeMetricStreamBatch).toHaveBeenCalledTimes(2);
    expect(writeMetricStreamBatch).toHaveBeenCalledWith(
      db,
      [expect.objectContaining({ externalId: "1" })],
      expect.any(String),
      undefined,
      undefined,
    );
    expect(writeMetricStreamBatch).toHaveBeenCalledWith(
      db,
      [expect.objectContaining({ externalId: "2" })],
      expect.any(String),
      undefined,
      undefined,
    );
    expect(writeMetricStreamBatch).not.toHaveBeenCalledWith(
      db,
      [expect.objectContaining({ externalId: "3" })],
      expect.any(String),
      undefined,
      undefined,
    );
  });

  it("retains weight entries when pagination stalls on a repeated next URL", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";

    const repeatedNextUrl = "https://wger.de/api/v2/weightentry/?offset=50";
    let weightRequests = 0;

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/workoutsession/")) {
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes("/weightentry/")) {
        weightRequests += 1;
        return Response.json({
          count: 2,
          next: repeatedNextUrl,
          previous: null,
          results: [
            { id: 1, date: "2026-03-02", weight: "80.0" },
            { id: 2, date: "2026-03-01", weight: "79.5" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new WgerProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01") }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(weightRequests).toBe(2);
    expect(result.recordsSynced).toBe(4);
    expect(syncLogOutcomes.values).toContainEqual({
      dataType: "metric_stream",
      degradations: [
        expect.objectContaining({
          kind: "pagination_stalled",
          context: expect.objectContaining({
            cursorFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
            pagesFetched: 2,
          }),
        }),
      ],
    });
  });

  it("captures weight write errors without aborting the whole sync", async () => {
    process.env.WGER_CLIENT_ID = "id";
    process.env.WGER_CLIENT_SECRET = "secret";

    const { writeMetricStreamBatch } = await import("../db/metric-stream-writer.ts");
    vi.mocked(writeMetricStreamBatch)
      .mockRejectedValueOnce(new Error("weight write failed"))
      .mockResolvedValue(1);

    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/workoutsession/")) {
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      }
      if (url.includes("/weightentry/")) {
        return Response.json({
          count: 2,
          next: null,
          previous: null,
          results: [
            { id: 1, date: "2026-03-02", weight: "80.0" },
            { id: 2, date: "2026-03-01", weight: "79.5" },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const db = {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn().mockResolvedValue([]),
    };

    const provider = new WgerProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({
        db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01") }),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.externalId).toBe("1");
    expect(result.recordsSynced).toBe(1);
  });
});

describe("WgerProvider — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'wger'", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new WgerProvider(mockFetch);
    const setup = provider.authSetup();
    if (!setup.manualToken) throw new Error("expected manualToken");
    const err = await setup.manualToken
      .exchangeToken("refresh-token")
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("wger");
      expect(err.statusCode).toBe(429);
    }
  });
});
