import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceMetricStreamBatch } from "../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { deleteTokens, ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { captureException } from "../lib/error-reporting.ts";
import { AllTrailsProvider } from "./alltrails.ts";
import { allTrailsRecording, encodeAllTrailsPoints } from "./alltrails-test-helpers.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createMockDatabase } from "./test-helpers.ts";

vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn().mockResolvedValue("alltrails"),
  loadTokens: vi.fn(),
  saveTokens: vi.fn().mockResolvedValue(undefined),
  deleteTokens: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../db/provider-activity-sync.ts", () => ({
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-one" }),
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../db/metric-stream-writer.ts", () => ({
  replaceMetricStreamBatch: vi
    .fn()
    .mockResolvedValue({ rowCount: 2, deletedEventId: "deletion-one" }),
}));
vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

const NOW = Date.parse("2026-10-10T10:00:00Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";

function storedTokens(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "access-old",
    refreshToken: "refresh-old",
    expiresAt: new Date("2099-01-01"),
    providerAccountId: "123",
    scopes: null,
    ...overrides,
  };
}

function syncRun(signal?: AbortSignal) {
  return new SyncRun({
    db: createMockDatabase().db,
    window: SyncWindow.fromIsoRange({
      sinceIso: "2026-10-01T00:00:00Z",
      untilIso: "2026-10-11T00:00:00Z",
    }),
    userId: USER_ID,
    signal,
  });
}

function emptyPage() {
  return { maps: [], pageInfo: { hasNextPage: false, nextCursor: null } };
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

function tokenResponse(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "access-one",
    refresh_token: "refresh-one",
    expires_in: 3600,
    created_at: 1,
    token_type: "Bearer",
    user: { id: 123 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadTokens).mockResolvedValue(storedTokens());
  vi.mocked(saveTokens).mockResolvedValue(undefined);
  vi.stubEnv("ALLTRAILS_API_KEY", "test-app-key");
  vi.stubEnv("ALLTRAILS_CLIENT_ID", "test-client-id");
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

describe("AllTrails credential lifecycle", () => {
  it.each([429, 502, 503, 504])(
    "redacts upstream HTTP %i bodies while retaining typed retry metadata",
    async (status) => {
      const sentinel = "sentinel-private-auth-response";
      const provider = new AllTrailsProvider(async () =>
        json({ access_token: sentinel }, status, { "Retry-After": "37" }),
      );
      const result = await provider.sync(syncRun());
      expect(result.errors).toHaveLength(1);
      const cause = result.errors[0]?.cause;
      expect(cause).toBeInstanceOf(
        status === 429 ? ProviderRateLimitError : ProviderServiceUnavailableError,
      );
      expect(cause).toMatchObject({
        providerId: "alltrails",
        statusCode: status,
        retryAfterSeconds: 37,
      });
      const serialized = JSON.stringify(
        { result, reports: vi.mocked(captureException).mock.calls },
        (_key, value: unknown) => {
          if (value instanceof Error)
            return {
              ...value,
              name: value.name,
              message: value.message,
              stack: value.stack,
              cause: value.cause,
            };
          return value;
        },
      );
      expect(serialized).not.toContain(sentinel);
      expect(result.errors[0]?.message).toBe(
        `AllTrails request failed (HTTP ${status}). Try again.`,
      );
      expect(finishProviderActivityListSync).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit user before reading any credentials", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const run = syncRun();
    const unscoped = new SyncRun({ db: run.db, window: run.window });
    await expect(new AllTrailsProvider(fetchFn).sync(unscoped)).rejects.toThrow(
      "AllTrails sync requires userId.",
    );
    expect(loadTokens).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports a disconnected account before making an HTTP request", async () => {
    vi.mocked(loadTokens).mockResolvedValue(null);
    const fetchFn = vi.fn<typeof fetch>();
    const result = await new AllTrailsProvider(fetchFn).sync(syncRun());
    expect(result.errors[0]?.message).toBe(
      "AllTrails is not connected. Connect AllTrails and retry.",
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "alltrails" },
    });
  });

  it.each([undefined, "", "not-a-user-id"])(
    "rejects the stored account identity %j",
    async (providerAccountId) => {
      vi.mocked(loadTokens).mockResolvedValue(storedTokens({ providerAccountId }));
      const fetchFn = vi.fn<typeof fetch>();
      const result = await new AllTrailsProvider(fetchFn).sync(syncRun());
      expect(result.errors[0]?.message).toBe(
        "AllTrails account identity is missing. Reconnect AllTrails.",
      );
      expect(fetchFn).not.toHaveBeenCalled();
      expect(finishProviderActivityListSync).not.toHaveBeenCalled();
    },
  );

  it.each([null, ""])("requires a refresh token when access expires: %j", async (refreshToken) => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ refreshToken, expiresAt: new Date(0) }));
    const fetchFn = vi.fn<typeof fetch>();
    const result = await new AllTrailsProvider(fetchFn).sync(syncRun());
    expect(result.errors[0]?.message).toBe(
      "AllTrails refresh token is missing. Reconnect AllTrails.",
    );
    expect(fetchFn).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it.each([
    { remaining: 29_999, refreshes: true },
    { remaining: 30_000, refreshes: true },
    { remaining: 30_001, refreshes: false },
  ])(
    "refreshes at the exact 30-second safety boundary: $remaining ms",
    async ({ remaining, refreshes }) => {
      vi.mocked(loadTokens).mockResolvedValue(
        storedTokens({ expiresAt: new Date(NOW + remaining) }),
      );
      const requests: string[] = [];
      const provider = new AllTrailsProvider(async (input, init) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/identity/oauth/token")) return json(tokenResponse());
        expect(new Headers(init?.headers).get("X-AT-AUTH-TOKEN")).toBe(
          refreshes ? "access-one" : "access-old",
        );
        return json(emptyPage());
      });
      expect((await provider.sync(syncRun())).errors).toEqual([]);
      expect(saveTokens).toHaveBeenCalledTimes(refreshes ? 1 : 0);
      expect(requests).toHaveLength(refreshes ? 2 : 1);
    },
  );

  it("persists rotated credentials for the requested user before making an authenticated read", async () => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(0) }));
    let persisted = false;
    vi.mocked(saveTokens).mockImplementation(async () => {
      persisted = true;
    });
    const requests: { url: string; init?: RequestInit }[] = [];
    const provider = new AllTrailsProvider(async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/identity/oauth/token")) return json(tokenResponse({ user: undefined }));
      expect(persisted).toBe(true);
      expect(new Headers(init?.headers).get("X-AT-AUTH-TOKEN")).toBe("access-one");
      return json(emptyPage());
    });
    const run = syncRun();
    const result = await provider.sync(run);
    expect(result.errors).toEqual([]);
    expect(loadTokens).toHaveBeenCalledWith(run.db, "alltrails", USER_ID);
    expect(saveTokens).toHaveBeenCalledWith(
      run.db,
      "alltrails",
      {
        accessToken: "access-one",
        refreshToken: "refresh-one",
        expiresAt: new Date("2026-10-10T11:00:00Z"),
        providerAccountId: "123",
        scopes: null,
      },
      USER_ID,
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      client_id: "test-client-id",
      grant_type: "refresh_token",
      refresh_token: "refresh-old",
    });
  });

  it("stops before data requests when rotated-token persistence fails", async () => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(0) }));
    vi.mocked(saveTokens).mockRejectedValue(new Error("Credential storage unavailable"));
    const urls: string[] = [];
    const provider = new AllTrailsProvider(async (input) => {
      urls.push(String(input));
      return json(tokenResponse());
    });
    const result = await provider.sync(syncRun());
    expect(result.errors[0]?.message).toContain("Credential storage unavailable");
    expect(urls).toEqual(["https://api-v5.alltrails.com/identity/oauth/token"]);
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("rejects refresh responses without a rotated refresh token", async () => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(0) }));
    const provider = new AllTrailsProvider(async () =>
      json(tokenResponse({ refresh_token: undefined })),
    );
    const result = await provider.sync(syncRun());
    expect(result.errors[0]?.message).toMatch(/invalid.*token response/i);
    expect(saveTokens).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("refreshes and retries once when a previously usable token is rejected", async () => {
    let reads = 0;
    const provider = new AllTrailsProvider(async (input, init) => {
      if (String(input).endsWith("/identity/oauth/token")) return json(tokenResponse());
      reads++;
      const expected = reads === 1 ? "access-old" : "access-one";
      expect(new Headers(init?.headers).get("X-AT-AUTH-TOKEN")).toBe(expected);
      return reads === 1 ? json({ error: "invalid_token" }, 401) : json(emptyPage());
    });
    const result = await provider.sync(syncRun());
    expect(result.errors).toEqual([]);
    expect(reads).toBe(2);
    expect(saveTokens).toHaveBeenCalledTimes(1);
  });

  it("clears only the requested user's revoked refresh credential", async () => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(0) }));
    const provider = new AllTrailsProvider(async () => json({ error: "invalid_grant" }, 400));
    const run = syncRun();
    const result = await provider.sync(run);
    expect(result.errors[0]?.message).toMatch(/refresh token.*(revoked|expired)/i);
    expect(deleteTokens).toHaveBeenCalledWith(run.db, "alltrails", USER_ID);
  });

  it("treats a refresh invalid_grant response with HTTP 401 as revocation", async () => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(0) }));
    const provider = new AllTrailsProvider(async () => json({ error: "invalid_grant" }, 401));
    const run = syncRun();
    const result = await provider.sync(run);
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "refresh_token_revoked" });
    expect(deleteTokens).toHaveBeenCalledExactlyOnceWith(run.db, "alltrails", USER_ID);
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: 400,
      body: { error: "invalid_client" },
      message: "AllTrails request failed (HTTP 400). Try again.",
    },
    {
      status: 401,
      body: { error: "invalid_client" },
      message: "AllTrails request failed (HTTP 401). Try again.",
    },
    { status: 400, body: {}, message: "AllTrails request failed (HTTP 400). Try again." },
    {
      status: 400,
      body: { error: 123 },
      message: "AllTrails request failed (HTTP 400). Try again.",
    },
    {
      status: 403,
      body: { error: "invalid_grant" },
      message: "AllTrails request failed (HTTP 403). Try again.",
    },
    {
      status: 500,
      body: { error: "invalid_grant" },
      message: "AllTrails request failed (HTTP 500). Try again.",
    },
    {
      status: 200,
      body: { error: "invalid_grant" },
      message: "AllTrails returned an invalid token response. Reconnect AllTrails.",
    },
  ])(
    "retains credentials for a refresh failure without confirmed revocation: $status $body",
    async ({ status, body, message }) => {
      vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(0) }));
      const provider = new AllTrailsProvider(async () => json(body, status));
      const result = await provider.sync(syncRun());
      expect(result.errors[0]?.message).toBe(message);
      expect(deleteTokens).not.toHaveBeenCalled();
      expect(saveTokens).not.toHaveBeenCalled();
      expect(finishProviderActivityListSync).not.toHaveBeenCalled();
      for (const call of vi.mocked(captureException).mock.calls) {
        expect(call[1]).toMatchObject({ tags: { provider: "alltrails" } });
      }
      expect(captureException).toHaveBeenCalled();
    },
  );

  it("reports the second access-token rejection after exactly one refresh", async () => {
    let reads = 0;
    let refreshes = 0;
    const provider = new AllTrailsProvider(async (input) => {
      if (String(input).endsWith("/identity/oauth/token")) {
        refreshes++;
        return json(tokenResponse());
      }
      reads++;
      return new Response(null, { status: 401 });
    });
    const result = await provider.sync(syncRun());
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "access_token_expired" });
    expect(result.errors[0]?.message).toBe("AllTrails access token expired.");
    expect(reads).toBe(2);
    expect(refreshes).toBe(1);
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it.each([400, 403, 500])(
    "reports data HTTP %i without treating invalid_grant as a refresh revocation",
    async (status) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => json({ error: "invalid_grant" }, status));
      const result = await new AllTrailsProvider(fetchFn).sync(syncRun());
      expect(result.errors[0]?.message).toBe(
        `AllTrails request failed (HTTP ${status}). Try again.`,
      );
      expect(fetchFn).toHaveBeenCalledOnce();
      expect(saveTokens).not.toHaveBeenCalled();
      expect(deleteTokens).not.toHaveBeenCalled();
      for (const call of vi.mocked(captureException).mock.calls) {
        expect(call[1]).toMatchObject({ tags: { provider: "alltrails" } });
      }
      expect(captureException).toHaveBeenCalled();
    },
  );

  it("does not interpret a DataDome response header on successful JSON as a challenge", async () => {
    const provider = new AllTrailsProvider(async () =>
      json(emptyPage(), 200, { "x-datadome": "protected" }),
    );
    expect((await provider.sync(syncRun())).errors).toEqual([]);
    expect(finishProviderActivityListSync).toHaveBeenCalledOnce();
  });

  it("reports non-Error request failures and elapsed time without hiding the failure", async () => {
    const provider = new AllTrailsProvider(async () => {
      vi.mocked(Date.now).mockReturnValue(NOW + 750);
      throw "network unavailable";
    });
    const result = await provider.sync(syncRun());
    expect(result).toMatchObject({
      duration: 750,
      recordsSynced: 0,
      errors: [{ message: "AllTrails sync failed. Try again.", cause: "network unavailable" }],
    });
    expect(captureException).toHaveBeenCalledWith("network unavailable", {
      tags: { provider: "alltrails" },
    });
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("propagates cancellation during refresh without clearing credentials or reporting a spurious failure", async () => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(0) }));
    const controller = new AbortController();
    const provider = new AllTrailsProvider(async () => {
      controller.abort(new Error("Cancelled during refresh"));
      throw new Error("Aborted refresh request");
    });
    await expect(provider.sync(syncRun(controller.signal))).rejects.toThrow(
      "Cancelled during refresh",
    );
    expect(deleteTokens).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("propagates cancellation while parsing a response without reporting private parse fragments", async () => {
    const controller = new AbortController();
    const response = json(emptyPage());
    vi.spyOn(response, "json").mockImplementation(async () => {
      controller.abort(new Error("Cancelled during JSON read"));
      throw new SyntaxError("private-response-fragment");
    });
    const provider = new AllTrailsProvider(async () => response);
    await expect(provider.sync(syncRun(controller.signal))).rejects.toThrow(
      "Cancelled during JSON read",
    );
    expect(captureException).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("refreshes a rejected access token even when the 401 response has no JSON body", async () => {
    let reads = 0;
    const provider = new AllTrailsProvider(async (input) => {
      if (String(input).endsWith("/identity/oauth/token")) return json(tokenResponse());
      reads++;
      return reads === 1 ? new Response(null, { status: 401 }) : json(emptyPage());
    });
    expect((await provider.sync(syncRun())).errors).toEqual([]);
    expect(reads).toBe(2);
    expect(saveTokens).toHaveBeenCalledOnce();
  });

  it("propagates cancellation without making an HTTP request", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const provider = new AllTrailsProvider(fetchFn);
    const abort = new AbortController();
    abort.abort(new Error("Cancelled by user"));
    await expect(provider.sync(syncRun(abort.signal))).rejects.toThrow("Cancelled by user");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refreshes proactively when credentials expire during recording pagination", async () => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(NOW + 120_000) }));
    let refreshed = false;
    const provider = new AllTrailsProvider(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/identity/oauth/token") {
        refreshed = true;
        return json(tokenResponse());
      }
      if (url.pathname.endsWith("/maps/101")) {
        expect(refreshed).toBe(true);
        expect(new Headers(init?.headers).get("X-AT-AUTH-TOKEN")).toBe("access-one");
        return json({ maps: [allTrailsRecording()] });
      }
      vi.mocked(Date.now).mockReturnValue(NOW + 121_000);
      return json({ ...emptyPage(), maps: [{ id: 101 }] });
    });
    expect((await provider.sync(syncRun())).errors).toEqual([]);
    expect(saveTokens).toHaveBeenCalledOnce();
  });

  it("rejects an account change in a refresh response", async () => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(0) }));
    const provider = new AllTrailsProvider(async () => json(tokenResponse({ user: { id: 456 } })));
    expect((await provider.sync(syncRun())).errors[0]?.message).toMatch(/different account/i);
    expect(saveTokens).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("propagates cancellation during an HTTP read and does not reconcile", async () => {
    const controller = new AbortController();
    const provider = new AllTrailsProvider(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      controller.abort(new Error("Cancelled during read"));
      throw controller.signal.reason;
    });
    await expect(provider.sync(syncRun(controller.signal))).rejects.toThrow(
      "Cancelled during read",
    );
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });
});

describe("AllTrails authoritative pagination", () => {
  it("reconciles the exact user's window after an explicitly completed empty inventory", async () => {
    const provider = new AllTrailsProvider(async () => json(emptyPage()));
    const run = syncRun();
    expect((await provider.sync(run)).errors).toEqual([]);
    expect(finishProviderActivityListSync).toHaveBeenCalledWith(run.db, {
      providerId: "alltrails",
      userId: USER_ID,
      windowStart: new Date("2026-10-01T00:00:00Z"),
      windowEnd: new Date("2026-10-11T00:00:00Z"),
      presentExternalIds: new Set(),
    });
  });

  it("accepts an explicit completed page whose nullable next cursor is omitted", async () => {
    const provider = new AllTrailsProvider(async () =>
      json({ maps: [], pageInfo: { hasNextPage: false } }),
    );
    expect((await provider.sync(syncRun())).errors).toEqual([]);
    expect(finishProviderActivityListSync).toHaveBeenCalledOnce();
  });

  it("includes private history on every cursor page and preserves those recordings during reconciliation", async () => {
    const inventoryRequests: URL[] = [];
    const provider = new AllTrailsProvider(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/maps/101")) return json({ maps: [allTrailsRecording(101)] });
      if (url.pathname.endsWith("/maps/102")) return json({ maps: [allTrailsRecording(102)] });
      inventoryRequests.push(url);
      if (url.searchParams.get("allow_private") !== "true") return json(emptyPage());
      if (url.searchParams.get("after") === "private-history") {
        return json({ ...emptyPage(), maps: [{ id: 102 }] });
      }
      return json({
        maps: [{ id: 101 }],
        pageInfo: { hasNextPage: true, nextCursor: "private-history" },
      });
    });
    const run = syncRun();
    const result = await provider.sync(run);
    expect(result).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(inventoryRequests).toHaveLength(2);
    expect(inventoryRequests.map((url) => url.searchParams.get("allow_private"))).toEqual([
      "true",
      "true",
    ]);
    expect(inventoryRequests[1]?.searchParams.get("after")).toBe("private-history");
    expect(finishProviderActivityListSync).toHaveBeenCalledWith(
      run.db,
      expect.objectContaining({
        userId: USER_ID,
        presentExternalIds: new Set(["101", "102"]),
      }),
    );
  });

  it.each([
    { maps: [] },
    { maps: [], pageInfo: { hasNextPage: true, nextCursor: null } },
    { maps: [], pageInfo: { hasNextPage: true, nextCursor: "same-cursor" } },
  ])("does not infer absence from incomplete or cycling pagination: %j", async (page) => {
    const provider = new AllTrailsProvider(async () => json(page));
    const result = await provider.sync(syncRun());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });
});

describe("AllTrails raw recording ingestion", () => {
  function recordingProvider(recording: unknown) {
    return new AllTrailsProvider(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/maps/101")) return json({ maps: [recording] });
      return json({ ...emptyPage(), maps: [{ id: 101 }] });
    });
  }

  it("imports raw epoch samples, source timezone and segment identity for the requested user", async () => {
    const recording = allTrailsRecording();
    const requests: URL[] = [];
    const provider = new AllTrailsProvider(async (input, init) => {
      const url = new URL(String(input));
      requests.push(url);
      expect(new Headers(init?.headers).get("X-AT-CLIENT-ID")).toBe("test-client-id");
      return json(
        url.pathname.endsWith("/maps/101")
          ? { maps: [recording] }
          : { ...emptyPage(), maps: [{ id: 101 }] },
      );
    });
    const run = syncRun();
    const result = await provider.sync(run);
    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(requests[0]?.pathname).toBe("/api/alltrails/users/123/maps");
    expect(requests[0]?.searchParams.get("presentation_type")).toBe("track");
    expect(requests[0]?.searchParams.get("detail")).toBe("deep");
    expect(requests[1]?.searchParams.get("combine_segments")).toBe("false");
    expect(upsertProviderActivity).toHaveBeenCalledWith(
      run.db,
      expect.objectContaining({
        userId: USER_ID,
        providerId: "alltrails",
        externalId: "101",
        name: "Morning hike 101",
        startedAt: new Date("2026-10-10T17:00:00Z"),
        endedAt: new Date("2026-10-10T17:05:15.500Z"),
        timezone: "America/Los_Angeles",
        localTimeCoordinates: { latitude: 37.75, longitude: -122.45 },
        raw: recording,
      }),
      expect.any(Object),
    );
    const call = vi.mocked(replaceMetricStreamBatch).mock.calls[0];
    expect(call?.[1]).toEqual({ activityId: "activity-one", userId: USER_ID });
    const rows = call?.[2];
    expect(rows).toHaveLength(4);
    expect(rows?.[0]).toMatchObject({
      userId: USER_ID,
      providerId: "alltrails",
      activityId: "activity-one",
      recordedAt: new Date("2026-10-10T17:00:00Z"),
      lat: 37.75,
      lng: -122.45,
      altitude: 12.5,
      horizontalAccuracy: 4,
      raw: { trackId: "1010", segmentId: "10100", segmentIndex: 0, pointIndex: 0 },
    });
    expect(rows?.[2]).toMatchObject({
      recordedAt: new Date("2026-10-10T17:05:00Z"),
      raw: { segmentId: "10101", segmentIndex: 1, pointIndex: 0 },
    });
    expect(new Set(rows?.map((row) => row.externalId)).size).toBe(4);
    expect(finishProviderActivityListSync).toHaveBeenCalledOnce();
  });

  it("decodes negative deltas, zero elevation and timestamp varints larger than 32 bits", async () => {
    const epoch = Date.parse("2026-10-10T17:00:00Z") / 1000;
    const recording = allTrailsRecording();
    const track = recording.tracks[0];
    if (!track) throw new Error("Missing fixture track");
    track.lineTimedSegments = [
      {
        id: 1,
        sequence_num: 0,
        polyline: {
          ndimensionalData: encodeAllTrailsPoints([
            [-40, -120, 0, epoch + 10.25, 6, 6],
            [-40.01, -120.01, -5.75, epoch, 4, 4],
            [-40.01, -120.01, -5.75, epoch, 4, 4],
          ]),
        },
      },
    ];
    expect((await recordingProvider(recording).sync(syncRun())).errors).toEqual([]);
    const rows = vi.mocked(replaceMetricStreamBatch).mock.calls[0]?.[2];
    expect(rows?.[0]).toMatchObject({
      altitude: 0,
      recordedAt: new Date("2026-10-10T17:00:10.250Z"),
    });
    expect(rows?.[1]).toMatchObject({
      lat: -40.01,
      lng: -120.01,
      altitude: -5.75,
      recordedAt: new Date("2026-10-10T17:00:00Z"),
    });
    expect(new Set(rows?.map((row) => row.externalId)).size).toBe(3);
    expect(vi.mocked(upsertProviderActivity).mock.calls[0]?.[1].startedAt).toEqual(
      new Date("2026-10-10T17:00:00Z"),
    );
  });

  it("preserves raw null timezone while supplying GPS evidence to the shared local-time resolver", async () => {
    const recording = allTrailsRecording();
    const raw = { ...recording, metadata: { ...recording.metadata, timezone: null } };
    expect((await recordingProvider(raw).sync(syncRun())).errors).toEqual([]);
    expect(vi.mocked(upsertProviderActivity).mock.calls[0]?.[1]).toMatchObject({
      raw,
      localTimeCoordinates: { latitude: 37.75, longitude: -122.45 },
    });
  });

  it.each(["_", "?", "~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~?", "\u0000"])(
    "rejects malformed or overflowing native samples before replacing existing data: %j",
    async (encoded) => {
      const recording = allTrailsRecording();
      const segment = recording.tracks[0]?.lineTimedSegments[1];
      if (!segment) throw new Error("Missing fixture segment");
      segment.polyline.ndimensionalData = encoded;
      const result = await recordingProvider(recording).sync(syncRun());
      expect(result.errors[0]).toMatchObject({ externalId: "101" });
      expect(upsertProviderActivity).not.toHaveBeenCalled();
      expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
      expect(finishProviderActivityListSync).not.toHaveBeenCalled();
    },
  );

  it("reports unsupported split timing without inventing an epoch from metadata or indexedTimeData", async () => {
    const recording = {
      ...allTrailsRecording(),
      tracks: [
        {
          id: 1,
          lineTimedSegments: [
            {
              id: 1,
              polyline: { pointsData: "??", indexedTimeData: "??", indexedElevationData: "??" },
            },
          ],
        },
      ],
    };
    const result = await recordingProvider(recording).sync(syncRun());
    expect(result.errors[0]).toMatchObject({ externalId: "101" });
    expect(result.errors[0]?.message).toMatch(/timestamp|timed|format/i);
    expect(upsertProviderActivity).not.toHaveBeenCalled();
    expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("preserves a successful recording when a later inventory page fails, without retiring absences", async () => {
    const urls: URL[] = [];
    const provider = new AllTrailsProvider(async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.endsWith("/maps/101")) return json({ maps: [allTrailsRecording()] });
      if (url.searchParams.has("after")) return json({ error: "unavailable" }, 503);
      return json({ maps: [{ id: 101 }], pageInfo: { hasNextPage: true, nextCursor: "next" } });
    });
    const result = await provider.sync(syncRun());
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(urls.at(-1)?.searchParams.get("after")).toBe("next");
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AllTrails connection", () => {
  it("redacts malformed auth JSON before reporting or throwing its parsing failure", async () => {
    const provider = new AllTrailsProvider(
      async () =>
        new Response('{"access_token":"sentinel-private-token', {
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      provider.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
    ).rejects.toThrow("AllTrails returned an invalid JSON response. Try again.");
    const reported = vi.mocked(captureException).mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported).toMatchObject({
      message: "AllTrails returned an invalid JSON response. Try again.",
    });
    expect(reported instanceof Error && reported.cause).toBeUndefined();
    expect(captureException).toHaveBeenCalledWith(reported, { tags: { provider: "alltrails" } });
  });
  it.each([
    { key: "ALLTRAILS_API_KEY", value: undefined },
    { key: "ALLTRAILS_API_KEY", value: "" },
    { key: "ALLTRAILS_API_KEY", value: " \t " },
    { key: "ALLTRAILS_CLIENT_ID", value: undefined },
    { key: "ALLTRAILS_CLIENT_ID", value: "" },
    { key: "ALLTRAILS_CLIENT_ID", value: " \t " },
  ])(
    "rejects missing or blank app configuration before touching credentials: $key $value",
    async ({ key, value }) => {
      vi.stubEnv(key, value);
      const fetchFn = vi.fn<typeof fetch>();
      const provider = new AllTrailsProvider(fetchFn);
      expect(provider.validate()).toBe(`${key} is required`);
      await expect(
        provider.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
      ).rejects.toThrow(`${key} is required`);
      expect((await provider.sync(syncRun())).errors[0]?.message).toBe(`${key} is required`);
      expect(ensureProvider).not.toHaveBeenCalled();
      expect(loadTokens).not.toHaveBeenCalled();
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("trims configured app credentials before sending the native login request", async () => {
    vi.stubEnv("ALLTRAILS_API_KEY", "  test-app-key  ");
    vi.stubEnv("ALLTRAILS_CLIENT_ID", "  test-client-id  ");
    const requests: RequestInit[] = [];
    const provider = new AllTrailsProvider(async (_input, init) => {
      if (!init) throw new Error("Missing login request options");
      requests.push(init);
      return json(tokenResponse());
    });
    await provider.authSetup().automatedLogin?.("hiker@example.test", "account-password");
    expect(requests[0]?.headers).toMatchObject({
      "X-AT-KEY": "test-app-key",
      "X-AT-CLIENT-ID": "test-client-id",
    });
    expect(JSON.parse(String(requests[0]?.body))).toMatchObject({ client_id: "test-client-id" });
  });

  it("rejects a successful password grant that omits the account identity", async () => {
    const provider = new AllTrailsProvider(async () => json(tokenResponse({ user: undefined })));
    await expect(
      provider.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
    ).rejects.toThrow("AllTrails returned an incomplete token response. Reconnect AllTrails.");
  });

  it("rejects a finite token lifetime that overflows the JavaScript date range", async () => {
    const provider = new AllTrailsProvider(async () => json(tokenResponse({ expires_in: 1e20 })));
    await expect(
      provider.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
    ).rejects.toThrow("AllTrails returned an invalid token response. Reconnect AllTrails.");
  });

  it.each([400, 401])(
    "classifies an explicit password invalid_grant on HTTP %i as invalid credentials",
    async (status) => {
      const provider = new AllTrailsProvider(async () => json({ error: "invalid_grant" }, status));
      await expect(
        provider.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
      ).rejects.toMatchObject({
        message: "AllTrails login failed: invalid email or password.",
        authFailureReason: "authentication_failed",
      });
    },
  );

  it.each([
    { status: 400, body: { error: "invalid_client" } },
    { status: 401, body: { error: "invalid_client" } },
    { status: 400, body: {} },
    { status: 401, body: { error: 123 } },
    { status: 403, body: { error: "invalid_grant" } },
    { status: 500, body: { error: "invalid_grant" } },
  ])(
    "reports a password HTTP $status without blaming credentials absent confirmed invalid_grant",
    async ({ status, body }) => {
      const provider = new AllTrailsProvider(async () => json(body, status));
      await expect(
        provider.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
      ).rejects.toThrow(`AllTrails request failed (HTTP ${status}). Try again.`);
      expect(deleteTokens).not.toHaveBeenCalled();
    },
  );

  it.each([200, 403])(
    "surfaces an HTML security response with HTTP %i as human verification",
    async (status) => {
      const provider = new AllTrailsProvider(
        async () =>
          new Response("<html>private challenge</html>", {
            status,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
      );
      await expect(
        provider.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
      ).rejects.toMatchObject({
        name: "ProviderVerificationRequiredError",
        message:
          "AllTrails requires human verification and is blocking this connection. Dofek cannot complete this check automatically. Contact support for help connecting.",
      });
      expect(deleteTokens).not.toHaveBeenCalled();
    },
  );
  it("requires app configuration before offering a connection", () => {
    vi.stubEnv("ALLTRAILS_API_KEY", "");
    expect(new AllTrailsProvider().validate()).toContain("ALLTRAILS_API_KEY");
    vi.stubEnv("ALLTRAILS_API_KEY", "app-key");
    vi.stubEnv("ALLTRAILS_CLIENT_ID", "");
    expect(new AllTrailsProvider().validate()).toContain("ALLTRAILS_CLIENT_ID");
    vi.stubEnv("ALLTRAILS_CLIENT_ID", "client-id");
    expect(new AllTrailsProvider().validate()).toBeNull();
  });

  it("uses the native password grant and preserves the account identity and relative expiry", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetchFn: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      return json(tokenResponse());
    };
    const setup = new AllTrailsProvider(fetchFn).authSetup();
    expect(setup.automatedLogin).toBeTypeOf("function");
    const tokens = await setup.automatedLogin?.("hiker@example.test", "account-password");
    expect(tokens).toEqual({
      accessToken: "access-one",
      refreshToken: "refresh-one",
      expiresAt: new Date("2026-10-10T11:00:00Z"),
      providerAccountId: "123",
      scopes: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api-v5.alltrails.com/identity/oauth/token");
    expect(requests[0]?.init?.method).toBe("POST");
    expect(new Headers(requests[0]?.init?.headers).get("X-AT-KEY")).toBe("test-app-key");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      client_id: "test-client-id",
      grant_type: "password",
      username: "hiker@example.test",
      password: "account-password",
    });
  });

  it.each([
    { refresh_token: undefined },
    { access_token: "" },
    { expires_in: 0 },
    { expires_in: Number.NaN },
    { user: {} },
  ])("rejects unusable token responses without exposing credentials: %j", async (overrides) => {
    const provider = new AllTrailsProvider(async () => json(tokenResponse(overrides)));
    const login = provider.authSetup().automatedLogin;
    expect(login).toBeTypeOf("function");
    await expect(login?.("hiker@example.test", "account-password")).rejects.toThrow(
      /AllTrails.*(invalid|incomplete).*response/i,
    );
  });

  it("distinguishes invalid credentials from a human-verification challenge and redacts both", async () => {
    const invalid = new AllTrailsProvider(async () =>
      json({ error: "invalid_grant", password: "account-password" }, 401),
    );
    await expect(
      invalid.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
    ).rejects.toThrow(/invalid email or password/i);

    const challenge = new AllTrailsProvider(async () =>
      json({ url: "https://geo.captcha-delivery.com/?cid=secret-challenge" }, 403, {
        "x-datadome": "protected",
      }),
    );
    await expect(
      challenge.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
    ).rejects.toThrow(/AllTrails.*human verification/i);
  });
});

describe("AllTrails native sample validation", () => {
  const epoch = Date.parse("2026-10-10T17:00:00Z") / 1000;

  function sampleProvider(encoded: string) {
    const recording = allTrailsRecording();
    const track = recording.tracks[0];
    if (!track) throw new Error("Missing fixture track");
    track.lineTimedSegments = [
      { id: 100, sequence_num: 7, polyline: { ndimensionalData: encoded } },
    ];
    return new AllTrailsProvider(async (input) =>
      json(
        String(input).includes("/maps/101?")
          ? { maps: [recording] }
          : { ...emptyPage(), maps: [{ id: 101 }] },
      ),
    );
  }

  it.each(["_", "?", "\u0000", "\u007f", `${"_".repeat(13)}??????`])(
    "reports malformed six-axis encodings specifically before writing: %j",
    async (encoded) => {
      const result = await sampleProvider(encoded).sync(syncRun());
      expect(result.recordsSynced).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({
        externalId: "101",
        message: "AllTrails returned malformed native timestamped GPS data. Retry this recording.",
        cause: expect.any(Error),
      });
      expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { provider: "alltrails" },
      });
      expect(upsertProviderActivity).not.toHaveBeenCalled();
      expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
      expect(finishProviderActivityListSync).not.toHaveBeenCalled();
    },
  );

  it.each(["_", "\u0000", "\u007f"])(
    "rejects an invalid final component even when the first five axes are complete: %j",
    async (suffix) => {
      const prefix = encodeAllTrailsPoints([[0, 0, 0, epoch, 1, 0]]).slice(0, -1);
      const result = await sampleProvider(`${prefix}${suffix}`).sync(syncRun());
      expect(result.errors[0]?.message).toBe(
        "AllTrails returned malformed native timestamped GPS data. Retry this recording.",
      );
      expect(upsertProviderActivity).not.toHaveBeenCalled();
      expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
      expect(finishProviderActivityListSync).not.toHaveBeenCalled();
    },
  );

  it("accepts a valid value whose final encoded chunk occurs at bit 60", async () => {
    const encoded = "_".repeat(12) + encodeAllTrailsPoints([[0, 0, 0, epoch, 0, 0]]);
    expect(await sampleProvider(encoded).sync(syncRun())).toMatchObject({
      recordsSynced: 1,
      errors: [],
    });
    expect(vi.mocked(replaceMetricStreamBatch).mock.calls[0]?.[2]?.[0]).toMatchObject({
      lat: 0,
      lng: 0,
      altitude: 0,
      horizontalAccuracy: 0,
    });
  });

  it.each([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])(
    "preserves an exactly representable altitude integer boundary: %s",
    async (integer) => {
      const altitude = integer / 100_000;
      const result = await sampleProvider(
        encodeAllTrailsPoints([[0, 0, altitude, epoch, 1, 1]]),
      ).sync(syncRun());
      expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
      expect(vi.mocked(replaceMetricStreamBatch).mock.calls[0]?.[2]?.[0]?.altitude).toBe(altitude);
    },
  );

  it.each([Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1])(
    "rejects altitude accumulators outside exact JavaScript integer precision: %s",
    async (integer) => {
      const result = await sampleProvider(
        encodeAllTrailsPoints([[0, 0, integer / 100_000, epoch, 1, 1]]),
      ).sync(syncRun());
      expect(result.errors[0]?.message).toBe(
        "AllTrails returned malformed native timestamped GPS data. Retry this recording.",
      );
      expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
    },
  );

  it.each([
    [90.00001, 0, 0, epoch, 1, 1],
    [-90.00001, 0, 0, epoch, 1, 1],
    [0, 180.00001, 0, epoch, 1, 1],
    [0, -180.00001, 0, epoch, 1, 1],
    [0, 0, 0, 0, 1, 1],
    [0, 0, 0, -1, 1, 1],
    [0, 0, 0, epoch, -0.00001, 1],
  ])("rejects invalid native sample values: %j", async (...point) => {
    const result = await sampleProvider(encodeAllTrailsPoints([point])).sync(syncRun());
    expect(result.errors[0]?.message).toBe(
      "AllTrails recording contains invalid native timestamped GPS data. Retry this recording.",
    );
    expect(upsertProviderActivity).not.toHaveBeenCalled();
    expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it.each([
    [90, 180],
    [-90, -180],
  ])("accepts geographic boundaries and zero GPS accuracy: %j", async (latitude, longitude) => {
    const result = await sampleProvider(
      encodeAllTrailsPoints([[latitude, longitude, 0, epoch, 0, 0]]),
    ).sync(syncRun());
    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(vi.mocked(replaceMetricStreamBatch).mock.calls[0]?.[2]?.[0]).toMatchObject({
      lat: latitude,
      lng: longitude,
      horizontalAccuracy: 0,
    });
  });

  it("rejects epoch values outside the JavaScript Date range", async () => {
    const result = await sampleProvider(
      encodeAllTrailsPoints([[0, 0, 0, 9_000_000_000_000, 1, 1]]),
    ).sync(syncRun());
    expect(result.errors[0]?.message).toBe(
      "AllTrails recording contains an invalid GPS timestamp. Retry this recording.",
    );
    expect(upsertProviderActivity).not.toHaveBeenCalled();
    expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
  });

  it("reports a recording with no raw segments before inserting an activity", async () => {
    const recording = { ...allTrailsRecording(), tracks: [] };
    const provider = new AllTrailsProvider(async (input) =>
      json(
        String(input).includes("/maps/101?")
          ? { maps: [recording] }
          : { ...emptyPage(), maps: [{ id: 101 }] },
      ),
    );
    const result = await provider.sync(syncRun());
    expect(result.errors[0]?.message).toBe(
      "AllTrails recording has no supported native timestamped GPS samples. No activity was imported.",
    );
    expect(upsertProviderActivity).not.toHaveBeenCalled();
    expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });
});

describe("AllTrails error reporting boundaries", () => {
  it("reports a malformed data response once while returning its sanitized failure", async () => {
    const provider = new AllTrailsProvider(
      async () =>
        new Response("malformed-data", {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const result = await provider.sync(syncRun());
    expect(result.errors[0]?.message).toBe(
      "AllTrails returned an invalid JSON response. Try again.",
    );
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(result.errors[0]?.cause, {
      tags: { provider: "alltrails" },
    });
  });

  it("reports a failed refresh once while preserving its credential", async () => {
    vi.mocked(loadTokens).mockResolvedValue(storedTokens({ expiresAt: new Date(0) }));
    const provider = new AllTrailsProvider(async () => json({ error: "server_error" }, 503));
    const result = await provider.sync(syncRun());
    expect(result.errors[0]?.message).toBe("AllTrails request failed (HTTP 503). Try again.");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it("reports an unexpected login failure once without retaining its response body", async () => {
    const provider = new AllTrailsProvider(
      async () =>
        new Response("sentinel-secret", {
          headers: { "Content-Type": "application/json" },
        }),
    );
    await expect(
      provider.authSetup().automatedLogin?.("hiker@example.test", "account-password"),
    ).rejects.toThrow("AllTrails returned an invalid JSON response. Try again.");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]?.[0]).toMatchObject({
      message: "AllTrails returned an invalid JSON response. Try again.",
    });
    const error = vi.mocked(captureException).mock.calls[0]?.[0];
    expect(error instanceof Error && error.cause).toBeUndefined();
  });
});

describe("AllTrails recording inventory and persistence boundaries", () => {
  beforeEach(() => {
    vi.mocked(upsertProviderActivity).mockReset().mockResolvedValue({ id: "activity-one" });
    vi.mocked(replaceMetricStreamBatch)
      .mockReset()
      .mockResolvedValue({ rowCount: 4, deletedEventId: "deletion-one" });
  });

  function providerWithDetail(detail: unknown) {
    return new AllTrailsProvider(async (input) => {
      const url = new URL(String(input));
      return json(
        url.pathname.endsWith("/maps/101") ? detail : { ...emptyPage(), maps: [{ id: 101 }] },
      );
    });
  }

  it.each([
    { maps: [] },
    { maps: "not-an-array", pageInfo: { hasNextPage: false } },
    { maps: [{}], pageInfo: { hasNextPage: false } },
  ])("reports an actionable incomplete inventory error: %j", async (inventory) => {
    const result = await new AllTrailsProvider(async () => json(inventory)).sync(syncRun());

    expect(result).toMatchObject({ recordsSynced: 0 });
    expect(result.errors).toEqual([
      expect.objectContaining({
        message: "AllTrails returned an incomplete recording inventory. Retry the sync.",
      }),
    ]);
    expect(upsertProviderActivity).not.toHaveBeenCalled();
    expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { maps: "not-an-array" },
    { maps: [] },
    { maps: [allTrailsRecording(), allTrailsRecording(102)] },
  ])("rejects an invalid recording response envelope before writing: %j", async (envelope) => {
    const result = await providerWithDetail(envelope).sync(syncRun());

    expect(result).toMatchObject({ recordsSynced: 0 });
    expect(result.errors).toEqual([
      expect.objectContaining({
        externalId: "101",
        message: "AllTrails returned an invalid recording detail. Retry the sync.",
      }),
    ]);
    expect(upsertProviderActivity).not.toHaveBeenCalled();
    expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it.each([
    { id: 101 },
    { ...allTrailsRecording(), activity: { name: "Hiking" } },
    allTrailsRecording(102),
  ])("rejects malformed or mismatched recording identity before writing: %j", async (recording) => {
    const result = await providerWithDetail({ maps: [recording] }).sync(syncRun());

    expect(result).toMatchObject({ recordsSynced: 0 });
    expect(result.errors).toEqual([
      expect.objectContaining({
        externalId: "101",
        message: "AllTrails returned an invalid recording detail. Retry the sync.",
      }),
    ]);
    expect(upsertProviderActivity).not.toHaveBeenCalled();
    expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("imports overlapping history pages once per recording identity", async () => {
    const detailIds: string[] = [];
    const provider = new AllTrailsProvider(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/alltrails/users/123/maps") {
        return json(
          url.searchParams.has("after")
            ? { ...emptyPage(), maps: [{ id: 101 }, { id: 102 }] }
            : { maps: [{ id: 101 }], pageInfo: { hasNextPage: true, nextCursor: "overlap" } },
        );
      }
      const id = url.pathname.split("/").at(-1);
      detailIds.push(String(id));
      return json({ maps: [allTrailsRecording(Number(id))] });
    });
    const run = syncRun();
    const result = await provider.sync(run);

    expect(result).toMatchObject({ recordsSynced: 2, errors: [] });
    expect(detailIds).toEqual(["101", "102"]);
    expect(upsertProviderActivity).toHaveBeenCalledTimes(2);
    expect(replaceMetricStreamBatch).toHaveBeenCalledTimes(2);
    expect(finishProviderActivityListSync).toHaveBeenCalledWith(
      run.db,
      expect.objectContaining({ presentExternalIds: new Set(["101", "102"]) }),
    );
  });

  it("imports a recording with omitted metadata using its raw GPS coordinates", async () => {
    const recording = { ...allTrailsRecording(), metadata: undefined };
    const result = await providerWithDetail({ maps: [recording] }).sync(syncRun());

    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    const values = vi.mocked(upsertProviderActivity).mock.calls[0]?.[1];
    expect(values).toMatchObject({
      localTimeCoordinates: { latitude: 37.75, longitude: -122.45 },
    });
    expect(values).not.toHaveProperty("timezone");
    expect(values).not.toHaveProperty("localTimeSource");
  });

  it("retains the earliest and latest source times when samples arrive out of order", async () => {
    const epoch = Date.parse("2026-10-10T17:00:00Z") / 1000;
    const recording = allTrailsRecording();
    const track = recording.tracks[0];
    if (!track) throw new Error("Missing fixture track");
    track.lineTimedSegments = [
      {
        id: 10100,
        sequence_num: 0,
        polyline: {
          ndimensionalData: encodeAllTrailsPoints([
            [37.75, -122.45, 12, epoch + 30, 4, 4],
            [37.75, -122.45, 12, epoch - 10, 4, 4],
            [37.75, -122.45, 12, epoch + 5, 4, 4],
          ]),
        },
      },
    ];
    const result = await providerWithDetail({ maps: [recording] }).sync(syncRun());

    expect(result).toMatchObject({ recordsSynced: 1, errors: [] });
    expect(vi.mocked(upsertProviderActivity).mock.calls[0]?.[1]).toMatchObject({
      startedAt: new Date("2026-10-10T16:59:50Z"),
      endedAt: new Date("2026-10-10T17:00:30Z"),
    });
  });

  it.each([
    { start: "2026-09-30T23:59:59.990Z", imported: false },
    { start: "2026-10-01T00:00:00.000Z", imported: true },
    { start: "2026-10-10T23:59:59.990Z", imported: true },
    { start: "2026-10-11T00:00:00.000Z", imported: false },
  ])("applies the half-open sync window to $start", async ({ start, imported }) => {
    const recording = allTrailsRecording();
    const track = recording.tracks[0];
    if (!track) throw new Error("Missing fixture track");
    track.lineTimedSegments = [
      {
        id: 10100,
        sequence_num: 0,
        polyline: {
          ndimensionalData: encodeAllTrailsPoints([
            [37.75, -122.45, 12, Date.parse(start) / 1000, 4, 4],
          ]),
        },
      },
    ];
    const result = await providerWithDetail({ maps: [recording] }).sync(syncRun());

    expect(result).toMatchObject({ recordsSynced: imported ? 1 : 0, errors: [] });
    expect(upsertProviderActivity).toHaveBeenCalledTimes(imported ? 1 : 0);
    expect(replaceMetricStreamBatch).toHaveBeenCalledTimes(imported ? 1 : 0);
    if (imported) {
      expect(vi.mocked(upsertProviderActivity).mock.calls[0]?.[1].startedAt).toEqual(
        new Date(start),
      );
    }
    expect(finishProviderActivityListSync).toHaveBeenCalledOnce();
  });

  it("reports an unsaved activity without replacing its samples or reconciling absence", async () => {
    vi.mocked(upsertProviderActivity).mockResolvedValueOnce(undefined);
    const result = await providerWithDetail({ maps: [allTrailsRecording()] }).sync(syncRun());

    expect(result).toMatchObject({ recordsSynced: 0 });
    expect(result.errors).toEqual([
      expect.objectContaining({
        externalId: "101",
        message: "AllTrails activity could not be saved. Retry the sync.",
      }),
    ]);
    expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("reports a recording's publish failure while preserving later successful imports", async () => {
    const failure = new Error("Metric publication unavailable");
    vi.mocked(replaceMetricStreamBatch).mockRejectedValueOnce(failure);
    const provider = new AllTrailsProvider(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/alltrails/users/123/maps") {
        return json({ ...emptyPage(), maps: [{ id: 101 }, { id: 102 }] });
      }
      return json({ maps: [allTrailsRecording(Number(url.pathname.split("/").at(-1)))] });
    });
    const result = await provider.sync(syncRun());

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toEqual([
      { message: "Metric publication unavailable", externalId: "101", cause: failure },
    ]);
    expect(captureException).toHaveBeenCalledWith(failure, { tags: { provider: "alltrails" } });
    expect(replaceMetricStreamBatch).toHaveBeenCalledTimes(2);
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("reports non-Error persistence failures with recording identity and provider attribution", async () => {
    const failure = { reason: "storage unavailable" };
    vi.mocked(upsertProviderActivity).mockRejectedValueOnce(failure);
    const result = await providerWithDetail({ maps: [allTrailsRecording()] }).sync(syncRun());

    expect(result).toMatchObject({ recordsSynced: 0 });
    expect(result.errors).toEqual([
      { message: "AllTrails sync failed. Try again.", externalId: "101", cause: failure },
    ]);
    expect(captureException).toHaveBeenCalledWith(failure, { tags: { provider: "alltrails" } });
    expect(replaceMetricStreamBatch).not.toHaveBeenCalled();
    expect(finishProviderActivityListSync).not.toHaveBeenCalled();
  });

  it("passes the requested user's activity scope and publisher to raw sample replacement", async () => {
    const publisher = { publishRows: async () => [] };
    const base = syncRun();
    const run = new SyncRun({
      db: base.db,
      window: base.window,
      userId: USER_ID,
      metricStreamPublisher: publisher,
    });
    expect((await providerWithDetail({ maps: [allTrailsRecording()] }).sync(run)).errors).toEqual(
      [],
    );

    const replacement = vi.mocked(replaceMetricStreamBatch).mock.calls[0];
    expect(replacement?.[0]).toBe(run.db);
    expect(replacement?.[1]).toEqual({ activityId: "activity-one", userId: USER_ID });
    expect(replacement?.[4]).toBe(publisher);
    expect(replacement?.[2]).toHaveLength(4);
    for (const sample of replacement?.[2] ?? []) {
      expect(sample).toMatchObject({
        activityId: "activity-one",
        userId: USER_ID,
        providerId: "alltrails",
      });
    }
  });

  it("returns the elapsed sync duration rather than an absolute timestamp", async () => {
    const provider = new AllTrailsProvider(async () => {
      vi.mocked(Date.now).mockReturnValue(NOW + 250);
      return json(emptyPage());
    });
    expect(await provider.sync(syncRun())).toMatchObject({
      duration: 250,
      recordsSynced: 0,
      errors: [],
    });
  });
});
