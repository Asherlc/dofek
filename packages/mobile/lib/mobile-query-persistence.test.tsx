import { QUERY_CACHE_MAX_AGE_MS } from "@dofek/scoring/query-cache";
import { dehydrate, QueryClient, useIsRestoring } from "@tanstack/react-query";
import {
  persistQueryClient,
  persistQueryClientRestore,
} from "@tanstack/react-query-persist-client";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMobileQueryPersister,
  MOBILE_QUERY_CACHE_MAX_PERSISTED_BYTES,
  MobileQueryPersistenceProvider,
  mobileQueryCacheBuster,
  removeAllMobileQueryCaches,
  removeMobileQueryCache,
} from "./mobile-query-persistence";

const { mockCaptureException, mockLogInfo } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
  mockLogInfo: vi.fn(),
}));

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
  logger: { info: mockLogInfo },
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

describe("mobile query persistence", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    await AsyncStorage.clear();
  });

  it("persists normal query data while leaving short-lived signed image URLs in memory", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const client = createQueryClient();
    function RestorationStatus() {
      return <span>{useIsRestoring() ? "restoring" : "restored"}</span>;
    }
    render(
      <MobileQueryPersistenceProvider queryClient={client} userId="image-owner">
        <RestorationStatus />
      </MobileQueryPersistenceProvider>,
    );
    await screen.findByText("restored");
    await act(async () => {
      await client.fetchQuery({
        queryKey: [["activity", "images"], { id: "activity-1" }],
        meta: { persist: false },
        queryFn: () => ({ images: [{ url: "https://private.test/image?signature=secret" }] }),
      });
      client.setQueryData(["dashboard"], { readiness: "cached" });
    });

    await waitFor(
      async () => {
        const stored = await AsyncStorage.getItem("dofek-query-cache:image-owner");
        expect(stored).toBeTruthy();
        expect(JSON.parse(stored ?? "null").clientState.queries).toEqual([
          expect.objectContaining({ queryKey: ["dashboard"] }),
        ]);
        expect(stored).not.toContain("signature");
      },
      { timeout: 3000 },
    );
  });

  it("reports downstream hydration failures safely and completes provider restoration", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const userId = "private-hydration-account";
    await AsyncStorage.setItem(
      `dofek-query-cache:${userId}`,
      JSON.stringify({
        timestamp: Date.now(),
        buster: mobileQueryCacheBuster(userId),
        clientState: { mutations: [], queries: { "private-health-record": "private-token" } },
      }),
    );
    function RestorationStatus() {
      return <span>{useIsRestoring() ? "restoring" : "restored"}</span>;
    }
    // TanStack logs the expected hydration rejection in development before rethrowing.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      render(
        <MobileQueryPersistenceProvider queryClient={createQueryClient()} userId={userId}>
          <RestorationStatus />
        </MobileQueryPersistenceProvider>,
      );
      expect(await screen.findByText("restored")).toBeTruthy();
      expect(consoleError).toHaveBeenCalledWith(expect.any(TypeError));
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith(`dofek-query-cache:${userId}`);
      expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "Mobile query persistence operation failed." }),
        { source: "mobile-query-cache-persist", category: "unknown", code: "unknown" },
      );
      const reportedError = mockCaptureException.mock.calls[0]?.[0];
      expect(reportedError).not.toHaveProperty("cause");
      expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("private-");
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("restores persisted user data before the query refetches", async () => {
    let resolveRefetch: ((value: { readiness: string }) => void) | undefined;
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "cached" });
    await AsyncStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now(),
        buster: mobileQueryCacheBuster("user-1"),
        clientState: dehydrate(seedClient),
      }),
    );

    const restoredClient = createQueryClient();
    const refetch = restoredClient.fetchQuery({
      queryKey: ["dashboard"],
      queryFn: () =>
        new Promise<{ readiness: string }>((resolve) => {
          resolveRefetch = resolve;
        }),
    });
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createMobileQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster("user-1"),
    });

    expect(restoredClient.getQueryData(["dashboard"])).toEqual({ readiness: "cached" });
    resolveRefetch?.({ readiness: "fresh" });
    await refetch;
  });

  it("discards strengths from v13 without unknown result counts", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const userId = "strengths-owner";
    const queryKey = [["climbing", "strengths"], { input: { days: 90 }, type: "query" }];
    const seedClient = createQueryClient();
    seedClient.setQueryData(queryKey, {
      panels: [
        {
          grades: [{ grade: "5.9", climbs: 1, sends: 1, successRate: 100 }],
          rows: [],
          progress: [],
          allGrades: { grades: [], rows: [], progress: [] },
        },
      ],
    });
    await AsyncStorage.setItem(
      `dofek-query-cache:${userId}`,
      JSON.stringify({
        timestamp: Date.now(),
        buster: `${userId}:v13`,
        clientState: dehydrate(seedClient),
      }),
    );
    const restoredClient = createQueryClient();
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createMobileQueryPersister(userId),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster(userId),
    });
    expect(restoredClient.getQueryData(queryKey)).toBeUndefined();
  });
  it("discards v11 metric sources without structured presentation before restoration completes", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const userId = "metric-source-owner";
    const queryKey = [
      ["activity", "metricSources"],
      { input: { id: "activity-1" }, type: "query" },
    ];
    const seedClient = createQueryClient();
    seedClient.setQueryData(queryKey, [
      {
        key: "heartRate",
        label: "Heart Rate",
        defaultSourceId: "whoop",
        sources: [{ id: "whoop", label: "WHOOP" }],
      },
    ]);
    await AsyncStorage.setItem(
      `dofek-query-cache:${userId}`,
      JSON.stringify({
        timestamp: Date.now(),
        buster: `${userId}:v11`,
        clientState: dehydrate(seedClient),
      }),
    );
    function RestorationStatus() {
      return <span>{useIsRestoring() ? "restoring" : "restored"}</span>;
    }
    const restoredClient = createQueryClient();
    render(
      <MobileQueryPersistenceProvider queryClient={restoredClient} userId={userId}>
        <RestorationStatus />
      </MobileQueryPersistenceProvider>,
    );
    expect(await screen.findByText("restored")).toBeTruthy();
    expect(restoredClient.getQueryData(queryKey)).toBeUndefined();
    await expect(AsyncStorage.getItem(`dofek-query-cache:${userId}`)).resolves.toBeNull();
  });

  it("discards v10 activity details without source trees before provider restoration completes", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const userId = "detail-owner";
    const queryKey = [["activity", "byId"], { input: { id: "activity-1" }, type: "query" }];
    const seedClient = createQueryClient();
    seedClient.setQueryData(queryKey, {
      id: "activity-1",
      name: "Morning Ride",
      providerId: "strava",
      sourceProviders: ["strava"],
      sourceLinks: [
        {
          providerId: "strava",
          externalId: "123",
          subsource: null,
          label: "Strava",
          url: "https://www.strava.com/activities/123",
          providerAbsentAt: null,
        },
      ],
      sourceDecision: null,
    });
    await AsyncStorage.setItem(
      `dofek-query-cache:${userId}`,
      JSON.stringify({
        timestamp: Date.now(),
        buster: `${userId}:v10`,
        clientState: dehydrate(seedClient),
      }),
    );

    function RestorationStatus() {
      return <span>{useIsRestoring() ? "restoring" : "restored"}</span>;
    }
    const restoredClient = createQueryClient();
    render(
      <MobileQueryPersistenceProvider queryClient={restoredClient} userId={userId}>
        <RestorationStatus />
      </MobileQueryPersistenceProvider>,
    );

    expect(await screen.findByText("restored")).toBeTruthy();
    expect(restoredClient.getQueryData(queryKey)).toBeUndefined();
    await expect(AsyncStorage.getItem(`dofek-query-cache:${userId}`)).resolves.toBeNull();
  });

  it("discards v9 calendar activities without source trees before provider restoration completes", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const queryKey = [["calendar", "weekList"], { input: { weeks: 4 }, type: "query" }];
    const seedClient = createQueryClient();
    seedClient.setQueryData(queryKey, [
      {
        date: "2026-03-18",
        activities: [
          {
            id: "activity-1",
            name: "Trainer Ride",
            activityType: "indoor_cycling",
            modality: null,
            startedAt: "2026-03-18T07:00:00.000Z",
            endedAt: "2026-03-18T08:00:00.000Z",
            localTimeContext: {
              timezone: null,
              startUtcOffsetMinutes: 60,
              endUtcOffsetMinutes: 60,
              source: "provider_offset",
            },
            durationMin: 60,
            source: {
              origin: { status: "unresolved", candidateMemberActivityIds: [] },
              primarySourceLabel: "Wahoo",
              sourceCount: 1,
              overlapSummary: null,
            },
            lastProcessedAt: "2026-03-18T08:05:00.000Z",
            distanceMeters: null,
            distanceState: { status: "missing", reason: "Distance not recorded" },
            elevationGainM: null,
            elevationState: { status: "missing", reason: "Elevation not recorded" },
            location: null,
            tss: 100,
            stats: [{ status: "available", label: "Training Stress Score", value: "100" }],
          },
        ],
      },
    ]);
    await AsyncStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now(),
        buster: "user-1:v9",
        clientState: dehydrate(seedClient),
      }),
    );

    function RestorationStatus() {
      return <span>{useIsRestoring() ? "restoring" : "restored"}</span>;
    }
    const restoredClient = createQueryClient();
    render(
      <MobileQueryPersistenceProvider queryClient={restoredClient} userId="user-1">
        <RestorationStatus />
      </MobileQueryPersistenceProvider>,
    );

    expect(await screen.findByText("restored")).toBeTruthy();
    expect(restoredClient.getQueryData(queryKey)).toBeUndefined();
    await expect(AsyncStorage.getItem("dofek-query-cache:user-1")).resolves.toBeNull();
  });

  it("scopes persisted data by authenticated user", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "cached" });
    await AsyncStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now(),
        buster: mobileQueryCacheBuster("user-1"),
        clientState: dehydrate(seedClient),
      }),
    );

    const restoredClient = createQueryClient();
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createMobileQueryPersister("user-2"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster("user-2"),
    });

    expect(restoredClient.getQueryData(["dashboard"])).toBeUndefined();
  });

  it("does not restore expired persisted data", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const seedClient = createQueryClient();
    seedClient.setQueryData(["dashboard"], { readiness: "old" });
    await AsyncStorage.setItem(
      "dofek-query-cache:user-1",
      JSON.stringify({
        timestamp: Date.now() - QUERY_CACHE_MAX_AGE_MS - 1,
        buster: mobileQueryCacheBuster("user-1"),
        clientState: dehydrate(seedClient),
      }),
    );

    const restoredClient = createQueryClient();
    await persistQueryClientRestore({
      queryClient: restoredClient,
      persister: createMobileQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster("user-1"),
    });

    expect(restoredClient.getQueryData(["dashboard"])).toBeUndefined();
  });

  it("clears only the active user's persisted cache on logout", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    await AsyncStorage.setItem("dofek-query-cache:user-1", "cache");
    await AsyncStorage.setItem("dofek-query-cache:user-2", "cache");

    await removeMobileQueryCache("user-1");

    await expect(AsyncStorage.getItem("dofek-query-cache:user-1")).resolves.toBeNull();
    await expect(AsyncStorage.getItem("dofek-query-cache:user-2")).resolves.toBe("cache");
  });

  it("clears every account cache during account erasure without touching unrelated storage", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    await AsyncStorage.setItem("dofek-query-cache:user-1", "cache");
    await AsyncStorage.setItem("dofek-query-cache:user-2", "cache");
    await AsyncStorage.setItem("unrelated-setting", "keep");

    await removeAllMobileQueryCaches();

    await expect(AsyncStorage.getItem("dofek-query-cache:user-1")).resolves.toBeNull();
    await expect(AsyncStorage.getItem("dofek-query-cache:user-2")).resolves.toBeNull();
    await expect(AsyncStorage.getItem("unrelated-setting")).resolves.toBe("keep");
  });

  it("never includes a raw user id in persistence error telemetry", async () => {
    const userId = "private-user-id";
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    vi.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(new Error("AsyncStorage unavailable"));

    await expect(removeMobileQueryCache(userId)).rejects.toThrow("AsyncStorage unavailable");

    const telemetry = mockCaptureException.mock.calls
      .map(
        ([error, context]) =>
          `${error instanceof Error ? error.message : String(error)} ${JSON.stringify(context)}`,
      )
      .join(" ");
    expect(telemetry).not.toContain(userId);
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "mobile-query-cache-clear",
      category: "unknown",
      code: "unknown",
    });
  });

  it("sanitizes telemetry while rethrowing clear-all failures", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    vi.mocked(AsyncStorage.getAllKeys).mockRejectedValueOnce(
      new Error("failed for dofek-query-cache:private-user-id"),
    );

    await expect(removeAllMobileQueryCaches()).rejects.toThrow("private-user-id");

    const [reportedError] = mockCaptureException.mock.calls[0] ?? [];
    expect(reportedError).toEqual(
      expect.objectContaining({ message: "Mobile query persistence operation failed." }),
    );
    expect(reportedError).not.toEqual(
      expect.objectContaining({ message: expect.stringContaining("private-user-id") }),
    );
  });

  it("drops oversized persisted caches instead of writing them (DOFEK-MOBILE-1E)", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const client = createQueryClient();
    client.setQueryData(["huge"], "x".repeat(MOBILE_QUERY_CACHE_MAX_PERSISTED_BYTES));

    await persistQueryClient({
      queryClient: client,
      persister: createMobileQueryPersister("user-1"),
      maxAge: QUERY_CACHE_MAX_AGE_MS,
      buster: mobileQueryCacheBuster("user-1"),
    });

    await expect(AsyncStorage.getItem("dofek-query-cache:user-1")).resolves.toBeNull();
  });

  it.each([
    ["Failed to read storage file.", "read-file"],
    ["Failed to write manifest file.", "write-manifest"],
    ["Failed to write value.", "write-value"],
    ["Failed to create storage directory.", "create-directory"],
    ["Failed to delete storage directory.", "delete-directory"],
    ["private native message", "unknown"],
    ["toString", "unknown"],
  ])("classifies %s without copying native messages or properties", async (message, category) => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const original = Object.assign(new Error(message), {
      code: "EACCES",
      key: "private-account",
      userInfo: { token: "private-token" },
    });
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(original);
    await expect(createMobileQueryPersister("private-account").restoreClient()).rejects.toBe(
      original,
    );
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "Mobile query persistence operation failed." }),
      { source: "mobile-query-cache-persist-read", category, code: "EACCES" },
    );
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("private-");
    expect(mockCaptureException.mock.calls[0]?.[0]).not.toHaveProperty("cause");
  });

  it("preserves remove rejection identity and rejects unknown diagnostic codes", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const original = Object.assign(new Error("private payload"), { code: "private-token" });
    vi.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(original);
    await expect(createMobileQueryPersister("private-account").removeClient()).rejects.toBe(
      original,
    );
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      source: "mobile-query-cache-persist-remove",
      category: "unknown",
      code: "unknown",
    });
  });

  it("classifies array-shaped bulk deletion errors and rethrows the original array", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    await AsyncStorage.setItem("dofek-query-cache:private-account", "private-data");
    const original = [new Error("Failed to write manifest file.")];
    vi.mocked(AsyncStorage.multiRemove).mockRejectedValueOnce(original);
    await expect(removeAllMobileQueryCaches()).rejects.toBe(original);
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      source: "mobile-query-cache-clear-all",
      category: "write-manifest",
      code: "unknown",
    });
  });

  it("reports the persister retry error with aggregate attempted write volume", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const original = Object.assign(new Error("Failed to write value."), { code: "ENOSPC" });
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(original);
    const persisted = {
      timestamp: 1,
      buster: "private-account",
      clientState: { queries: [], mutations: [] },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(persisted)).byteLength;
    await createMobileQueryPersister("private-account").persistClient(persisted);
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      source: "mobile-query-cache-persist-write",
      category: "write-value",
      code: "ENOSPC",
      writeCount: 1,
      totalWriteBytes: bytes,
      writeBytes: bytes,
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("private-account");
  });

  it.each([0, 1])("enforces the UTF-8 byte cap at limit + %i bytes", async (excess) => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    const persisted = { timestamp: 1, buster: "", clientState: { queries: [], mutations: [] } };
    const overhead = new TextEncoder().encode(JSON.stringify(persisted)).byteLength;
    const payloadBytes = MOBILE_QUERY_CACHE_MAX_PERSISTED_BYTES - overhead + excess;
    persisted.buster = "😀".repeat(Math.floor(payloadBytes / 4)) + "x".repeat(payloadBytes % 4);
    await createMobileQueryPersister("user-1").persistClient(persisted);
    if (excess === 0) {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "dofek-query-cache:user-1",
        JSON.stringify(persisted),
      );
    } else {
      expect(vi.mocked(AsyncStorage.setItem).mock.calls.length).toBe(0);
      expect(AsyncStorage.removeItem).toHaveBeenCalledWith("dofek-query-cache:user-1");
    }
  });

  it("logs only byte/count measurements for completed writes", async () => {
    vi.useFakeTimers();
    try {
      const persister = createMobileQueryPersister("private-account");
      const persisted = {
        timestamp: 1,
        buster: "private-health-😀",
        clientState: { queries: [], mutations: [] },
      };
      const bytes = new TextEncoder().encode(JSON.stringify(persisted)).byteLength;
      await persister.persistClient(persisted);
      await vi.advanceTimersByTimeAsync(1000);
      await persister.persistClient(persisted);
      expect(mockLogInfo).toHaveBeenLastCalledWith("mobile-query-cache", "Persisted query cache.", {
        writeBytes: bytes,
        writeCount: 2,
        totalWriteBytes: 2 * bytes,
      });
      expect(JSON.stringify(mockLogInfo.mock.calls)).not.toContain("private-");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports corrupt JSON at deserialization without leaking cached content", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    await AsyncStorage.setItem("dofek-query-cache:user-1", "private-corrupt-health-data");
    await expect(createMobileQueryPersister("user-1").restoreClient()).rejects.toBeInstanceOf(
      SyntaxError,
    );
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      source: "mobile-query-cache-deserialize",
      category: "invalid-json",
      code: "unknown",
    });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain("private-");
  });

  it("identifies oversized-cache removal failures with zero attempted writes", async () => {
    const AsyncStorage = (await import("@react-native-async-storage/async-storage")).default;
    vi.mocked(AsyncStorage.removeItem).mockRejectedValueOnce(
      new Error("Failed to write manifest file."),
    );
    const persisted = {
      timestamp: 1,
      buster: "x".repeat(MOBILE_QUERY_CACHE_MAX_PERSISTED_BYTES),
      clientState: { queries: [], mutations: [] },
    };
    await createMobileQueryPersister("user-1").persistClient(persisted);
    expect(mockCaptureException).toHaveBeenCalledExactlyOnceWith(expect.any(Error), {
      source: "mobile-query-cache-persist-remove",
      category: "write-manifest",
      code: "unknown",
      writeCount: 0,
      totalWriteBytes: 0,
      writeBytes: new TextEncoder().encode(JSON.stringify(persisted)).byteLength,
    });
  });
});
