import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceMetricStreamBatch } from "../db/metric-stream-writer.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { deleteTokens, loadTokens, saveTokens } from "../db/tokens.ts";
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
  });
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
