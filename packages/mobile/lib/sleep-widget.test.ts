import { formatDateYmd, shiftDateYmd } from "@dofek/format/format";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { getQueryKey } from "@trpc/react-query";
import { Alert, AppState } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "./auth-context";
import { defaultUser, importAuthApis, waitForAuthLoaded, wrapper } from "./auth-context.test-setup";
import * as sleepWidget from "./sleep-widget";
import {
  buildSleepWidgetWire,
  emptySnapshotExpiresAtMs,
  localMidnightMs,
  registerSleepWidgetPublisher,
  removeSleepWidgetSnapshot,
  restoreSleepWidgetWriter,
  retireSleepWidgetWriter,
  sleepRecordExpiresAtMs,
  writeSleepWidgetSignedOutMarker,
} from "./sleep-widget";
import { trpc } from "./trpc";

const replaceSnapshot = vi.hoisted(() => vi.fn());
const mockRemoveMobileQueryCache = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockClearAccountErasurePreparation = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockAuthSession = vi.hoisted(() => ({
  clearSessionToken: vi.fn(() => Promise.resolve()),
  createAccountErasureCleanupNonce: vi.fn(() => "22222222-2222-4222-8222-222222222222"),
  getOrCreateSessionOwnerNonce: vi.fn(() =>
    Promise.resolve("11111111-1111-4111-8111-111111111111"),
  ),
  getSavedSessionUser: vi.fn(),
  getSessionToken: vi.fn(() => Promise.resolve(null)),
  invalidateSessionPersistence: vi.fn(),
  rotateSessionOwnerNonce: vi.fn(() => Promise.resolve("11111111-1111-4111-8111-111111111111")),
  saveSessionToken: vi.fn(() => Promise.resolve()),
  saveSessionUser: vi.fn(() => Promise.resolve()),
}));
const mockGetSavedSessionUser = mockAuthSession.getSavedSessionUser;

vi.mock("../modules/sleep-widget", () => ({
  replaceSnapshot: (...args: unknown[]) => replaceSnapshot(...args),
}));
vi.mock("./mobile-query-persistence", () => ({
  removeMobileQueryCache: mockRemoveMobileQueryCache,
}));
vi.mock("./account-erasure-storage", () => ({
  clearMobileAccountErasurePreparation: mockClearAccountErasurePreparation,
}));
vi.mock("./telemetry", () => ({
  captureException: vi.fn(),
  identifyUser: vi.fn(),
  resetUser: vi.fn(),
}));
vi.mock("./startup-telemetry", () => ({
  startStartupPhase: vi.fn(),
  finishStartupPhase: vi.fn(),
}));
vi.mock("./auth-session", () => mockAuthSession);
vi.mock("./auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth")>();
  return {
    ...original,
    logout: vi.fn(() => Promise.resolve()),
    fetchCurrentUser: vi.fn(() => Promise.resolve(null)),
  };
});

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function dashboardQueryKey(endDate: string) {
  return getQueryKey(trpc.mobileDashboard.dashboardV2, { endDate }, "query");
}

function createPublisher(queryClient: QueryClient, now = () => new Date()) {
  return registerSleepWidgetPublisher({
    queryClient,
    now,
  });
}

async function fetchDashboard(
  queryClient: QueryClient,
  endDate: string,
  data: unknown,
  options?: { reject?: boolean },
) {
  const queryKey = dashboardQueryKey(endDate);
  const queryFn = options?.reject
    ? vi.fn(async () => {
        throw new Error("dashboard failed");
      })
    : vi.fn(async () => data);
  const observer = new QueryObserver(queryClient, {
    queryKey,
    queryFn,
    staleTime: 0,
    retry: false,
  });
  const unsubscribe = observer.subscribe(() => undefined);
  try {
    await observer.refetch();
  } finally {
    unsubscribe();
  }
  return queryFn;
}

describe("sleep widget wire builders", () => {
  it("expires a current or preceding local-day record at the start of the calendar day two days later", () => {
    expect(sleepRecordExpiresAtMs("2026-11-24")).toBe(localMidnightMs("2026-11-26"));
  });

  it("expires an empty successful response at the next local midnight", () => {
    const now = new Date(2026, 10, 24, 15, 30, 0, 0);
    expect(emptySnapshotExpiresAtMs(now)).toBe(localMidnightMs("2026-11-25"));
  });

  it("requires the sleep property, rounds duration, and rejects older nights", () => {
    const endDate = "2026-11-24";
    const now = new Date(2026, 10, 24, 12, 0, 0, 0);

    expect(
      buildSleepWidgetWire(
        { sleep: { lastNight: { date: endDate, durationMinutes: 444.6 } } },
        endDate,
        now,
      ),
    ).toBe(
      JSON.stringify({
        version: 1,
        kind: "sleep",
        date: endDate,
        durationMinutes: 445,
        expiresAt: sleepRecordExpiresAtMs(endDate),
      }),
    );

    expect(buildSleepWidgetWire({ sleep: null }, endDate, now)).toBe(
      JSON.stringify({
        version: 1,
        kind: "empty",
        expiresAt: emptySnapshotExpiresAtMs(now),
      }),
    );

    expect(buildSleepWidgetWire({ sleep: { lastNight: null } }, endDate, now)).toBe(
      JSON.stringify({
        version: 1,
        kind: "empty",
        expiresAt: emptySnapshotExpiresAtMs(now),
      }),
    );

    // Server always sends sleep; a missing key must not publish.
    expect(buildSleepWidgetWire({}, endDate, now)).toBeNull();

    expect(
      buildSleepWidgetWire(
        {
          sleep: {
            lastNight: { date: shiftDateYmd(endDate, -2), durationMinutes: 300 },
          },
        },
        endDate,
        now,
      ),
    ).toBeNull();
  });
});

describe("registerSleepWidgetPublisher", () => {
  let queryClient: QueryClient;
  let dispose: (() => void) | undefined;
  const fixedNow = () => new Date(2026, 10, 24, 12, 0, 0, 0);
  const endDate = "2026-11-24";

  beforeEach(() => {
    replaceSnapshot.mockReset();
    retireSleepWidgetWriter();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    dispose = createPublisher(queryClient, fixedNow).dispose;
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    queryClient.clear();
    retireSleepWidgetWriter();
  });

  it("publishes a successful dated dashboardV2 payload for the active activation", async () => {
    restoreSleepWidgetWriter(OWNER_A);
    await fetchDashboard(queryClient, endDate, {
      sleep: { lastNight: { date: endDate, durationMinutes: 444 } },
    });

    expect(replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(replaceSnapshot).toHaveBeenCalledWith(
      JSON.stringify({
        version: 1,
        kind: "sleep",
        date: endDate,
        durationMinutes: 444,
        expiresAt: sleepRecordExpiresAtMs(endDate),
      }),
    );
  });

  it("samples the local calendar once per network response", async () => {
    restoreSleepWidgetWriter(OWNER_A);
    const firstSample = new Date(2026, 10, 24, 12, 0, 0, 0);
    const laterSample = new Date(2026, 10, 25, 0, 0, 0, 1);
    let index = 0;
    dispose?.();
    dispose = createPublisher(queryClient, () => {
      index += 1;
      return index === 1 ? firstSample : laterSample;
    }).dispose;

    await fetchDashboard(queryClient, endDate, {
      sleep: { lastNight: { date: endDate, durationMinutes: 444 } },
    });

    expect(replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(index).toBe(1);
    expect(formatDateYmd(firstSample)).toBe(endDate);
  });

  it("keeps the same activation across ordinary same-owner re-verification", async () => {
    restoreSleepWidgetWriter(OWNER_A);
    await fetchDashboard(queryClient, endDate, {
      sleep: { lastNight: { date: endDate, durationMinutes: 400 } },
    });
    restoreSleepWidgetWriter(OWNER_A);
    await fetchDashboard(queryClient, endDate, {
      sleep: { lastNight: { date: endDate, durationMinutes: 410 } },
    });
    expect(replaceSnapshot).toHaveBeenCalledTimes(2);
    expect(replaceSnapshot).toHaveBeenLastCalledWith(
      JSON.stringify({
        version: 1,
        kind: "sleep",
        date: endDate,
        durationMinutes: 410,
        expiresAt: sleepRecordExpiresAtMs(endDate),
      }),
    );
  });

  it("rejects a retired completion after restoring the same durable nonce", async () => {
    restoreSleepWidgetWriter(OWNER_A);
    let finishA: ((value: unknown) => void) | undefined;
    const aPending = new Promise((resolve) => {
      finishA = resolve;
    });
    const queryKey = dashboardQueryKey(endDate);
    const observerA = new QueryObserver(queryClient, {
      queryKey,
      queryFn: async () => aPending,
      staleTime: 0,
    });
    const unsubscribeA = observerA.subscribe(() => undefined);
    const fetchA = observerA.refetch();

    retireSleepWidgetWriter();
    restoreSleepWidgetWriter(OWNER_A);

    finishA?.({ sleep: { lastNight: { date: endDate, durationMinutes: 999 } } });
    await fetchA;
    unsubscribeA();
    expect(replaceSnapshot).not.toHaveBeenCalled();

    await fetchDashboard(queryClient, endDate, { sleep: { lastNight: null } });
    expect(replaceSnapshot).toHaveBeenCalledTimes(1);
    expect(replaceSnapshot).toHaveBeenCalledWith(
      JSON.stringify({
        version: 1,
        kind: "empty",
        expiresAt: emptySnapshotExpiresAtMs(fixedNow()),
      }),
    );
  });

  it("does not write for cached/manual success, failed queries, or missing sleep", async () => {
    restoreSleepWidgetWriter(OWNER_A);
    const queryKey = dashboardQueryKey(endDate);

    queryClient.setQueryData(queryKey, {
      sleep: { lastNight: { date: endDate, durationMinutes: 444 } },
    });
    expect(replaceSnapshot).not.toHaveBeenCalled();

    await fetchDashboard(queryClient, endDate, { sleep: { lastNight: null } }, { reject: true });
    expect(replaceSnapshot).not.toHaveBeenCalled();

    await fetchDashboard(queryClient, endDate, {});
    expect(replaceSnapshot).not.toHaveBeenCalled();
  });

  it("removes the App Group file before writing the optional signed-out marker", () => {
    const calls: Array<string | null> = [];
    replaceSnapshot.mockImplementation((snapshot: string | null) => {
      calls.push(snapshot);
      if (snapshot !== null && calls.filter((value) => value === null).length === 0) {
        throw new Error("marker before remove");
      }
    });

    removeSleepWidgetSnapshot();
    writeSleepWidgetSignedOutMarker();

    expect(calls).toEqual([null, JSON.stringify({ version: 1, kind: "signedOut" })]);
  });

  it("lets signed-out marker failure stay telemetried after a successful remove", () => {
    replaceSnapshot.mockImplementation((snapshot: string | null) => {
      if (snapshot !== null) {
        throw new Error("Unable to write signed-out marker");
      }
    });

    removeSleepWidgetSnapshot();
    expect(() => writeSleepWidgetSignedOutMarker()).not.toThrow();
  });
});

describe("sleep widget AuthProvider fences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    AppState.currentState = "active";
    mockGetSavedSessionUser.mockResolvedValue(null);
    replaceSnapshot.mockReset().mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes the App Group file before retiring the writer or saving a replacement token", async () => {
    const { getSessionToken, fetchCurrentUser, rotateSessionOwnerNonce, saveSessionToken } =
      await importAuthApis();
    vi.mocked(getSessionToken).mockResolvedValue("existing-token");
    vi.mocked(fetchCurrentUser).mockResolvedValue(defaultUser);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(defaultUser));
    vi.mocked(saveSessionToken).mockClear();

    const order: string[] = [];
    vi.spyOn(sleepWidget, "removeSleepWidgetSnapshot").mockImplementation(() => {
      order.push("remove");
    });
    vi.spyOn(sleepWidget, "retireSleepWidgetWriter").mockImplementation(() => {
      order.push("retire");
    });
    const restoreSpy = vi.spyOn(sleepWidget, "restoreSleepWidgetWriter");
    vi.mocked(saveSessionToken).mockImplementation(async () => {
      order.push("save");
    });

    let finishRotate: ((value: string) => void) | undefined;
    vi.mocked(rotateSessionOwnerNonce).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finishRotate = resolve;
        }),
    );
    vi.mocked(fetchCurrentUser).mockResolvedValue({
      id: "user-2",
      name: "Second",
      email: null,
    });

    let login: Promise<void> | undefined;
    await act(async () => {
      login = result.current.onLoginSuccess("replacement-token");
      await Promise.resolve();
    });
    expect(order[0]).toBe("remove");
    expect(order.indexOf("remove")).toBeLessThan(order.indexOf("retire"));
    expect(order.indexOf("retire")).toBeLessThan(order.indexOf("save"));
    expect(result.current.accountSessionOwnerNonce).toEqual(expect.any(String));
    expect(restoreSpy).not.toHaveBeenCalled();

    await act(async () => {
      finishRotate?.("33333333-3333-4333-8333-333333333333");
      await login;
    });
    expect(restoreSpy).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333");
  });

  it("does not retire or save when App Group removal fails on login", async () => {
    const { getSessionToken, fetchCurrentUser, saveSessionToken } = await importAuthApis();
    vi.mocked(getSessionToken).mockResolvedValue("existing-token");
    vi.mocked(fetchCurrentUser).mockResolvedValue(defaultUser);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(defaultUser));
    vi.mocked(saveSessionToken).mockClear();
    const retireSpy = vi.spyOn(sleepWidget, "retireSleepWidgetWriter");
    vi.spyOn(sleepWidget, "removeSleepWidgetSnapshot").mockImplementation(() => {
      throw new Error("Unable to update the Sleep widget snapshot.");
    });

    await expect(
      act(async () => result.current.onLoginSuccess("replacement-token")),
    ).rejects.toThrow(/Unable to update the Sleep widget snapshot/);
    expect(saveSessionToken).not.toHaveBeenCalled();
    expect(retireSpy).not.toHaveBeenCalled();
    expect(result.current.user).toEqual(defaultUser);
    expect(result.current.sessionToken).toBe("existing-token");
  });

  it("keeps the session and shows an alert when explicit logout cannot remove the widget file", async () => {
    const { getSessionToken, fetchCurrentUser, logout: authLogout } = await importAuthApis();
    vi.mocked(getSessionToken).mockResolvedValue("test-token");
    vi.mocked(fetchCurrentUser).mockResolvedValue(defaultUser);
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => undefined);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(defaultUser));
    const retireSpy = vi.spyOn(sleepWidget, "retireSleepWidgetWriter");
    const markerSpy = vi.spyOn(sleepWidget, "writeSleepWidgetSignedOutMarker");
    vi.spyOn(sleepWidget, "removeSleepWidgetSnapshot").mockImplementation(() => {
      throw new Error("Unable to update the Sleep widget snapshot.");
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(result.current.user).toEqual(defaultUser);
    expect(result.current.sessionToken).toBe("test-token");
    expect(authLogout).not.toHaveBeenCalled();
    expect(retireSpy).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalledWith(
      "Unable to clear Sleep widget",
      expect.stringMatching(/could not remove the previous Sleep widget cache/i),
      expect.any(Array),
    );
    expect(markerSpy).not.toHaveBeenCalled();
  });

  it("writes the signed-out marker only after a successful remove on logout", async () => {
    const { getSessionToken, fetchCurrentUser } = await importAuthApis();
    vi.mocked(getSessionToken).mockResolvedValue("test-token");
    vi.mocked(fetchCurrentUser).mockResolvedValue(defaultUser);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(defaultUser));

    const order: string[] = [];
    vi.spyOn(sleepWidget, "removeSleepWidgetSnapshot").mockImplementation(() => {
      order.push("remove");
    });
    vi.spyOn(sleepWidget, "writeSleepWidgetSignedOutMarker").mockImplementation(() => {
      order.push("marker");
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(order).toEqual(["remove", "marker"]);
    expect(result.current.user).toBeNull();
  });

  it("starts token cleanup before awaiting erasure and cache cleanup on logout", async () => {
    const { getSessionToken, fetchCurrentUser, logout: authLogout } = await importAuthApis();
    vi.mocked(getSessionToken).mockResolvedValue("test-token");
    vi.mocked(fetchCurrentUser).mockResolvedValue(defaultUser);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(defaultUser));

    const order: string[] = [];
    let resolveLogout: (() => void) | undefined;
    vi.mocked(authLogout).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          order.push("logout-started");
          resolveLogout = resolve;
        }),
    );
    mockClearAccountErasurePreparation.mockImplementation(async () => {
      order.push("erasure");
    });
    mockRemoveMobileQueryCache.mockImplementation(async () => {
      order.push("cache");
    });

    await act(async () => {
      const pending = result.current.logout();
      await Promise.resolve();
      resolveLogout?.();
      await pending;
    });

    expect(order[0]).toBe("logout-started");
    expect(order.indexOf("logout-started")).toBeLessThan(order.indexOf("erasure"));
  });

  it("retires before remove on confirmed session clear and still clears the session token when remove fails", async () => {
    const { getSessionToken, fetchCurrentUser, clearSessionToken } = await importAuthApis();
    vi.mocked(getSessionToken).mockResolvedValue("revoked-token");
    vi.mocked(fetchCurrentUser).mockResolvedValue(null);
    vi.mocked(clearSessionToken).mockClear();

    const order: string[] = [];
    vi.spyOn(sleepWidget, "retireSleepWidgetWriter").mockImplementation(() => {
      order.push("retire");
    });
    vi.spyOn(sleepWidget, "removeSleepWidgetSnapshot").mockImplementation(() => {
      order.push("remove");
      throw new Error("Unable to update the Sleep widget snapshot.");
    });
    const markerSpy = vi.spyOn(sleepWidget, "writeSleepWidgetSignedOutMarker");

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bootstrapError).toMatch(/Sleep widget/i);
    expect(clearSessionToken).toHaveBeenCalled();
    expect(order[0]).toBe("retire");
    expect(order.indexOf("retire")).toBeLessThan(order.indexOf("remove"));
    expect(markerSpy).not.toHaveBeenCalled();

    vi.spyOn(sleepWidget, "removeSleepWidgetSnapshot").mockImplementation(() => undefined);
    markerSpy.mockImplementation(() => undefined);
    await act(async () => {
      await result.current.retryBootstrap();
    });
    await waitFor(() => expect(result.current.bootstrapError).toBeNull());
    expect(markerSpy).toHaveBeenCalled();
  });

  it("lets replacement login B finish when AppState retries bootstrap during verification", async () => {
    const { getSessionToken, fetchCurrentUser, rotateSessionOwnerNonce } = await importAuthApis();
    const appStateListeners: Array<(state: string) => void> = [];
    vi.mocked(AppState.addEventListener).mockImplementation((_event, listener) => {
      appStateListeners.push(listener);
      return { remove: vi.fn() };
    });
    vi.mocked(getSessionToken).mockResolvedValue("token-a");
    vi.mocked(fetchCurrentUser).mockResolvedValue(defaultUser);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(defaultUser));

    const userB = { id: "user-b", name: "User B", email: null };
    let finishLoginB: ((user: typeof userB) => void) | undefined;
    vi.mocked(fetchCurrentUser).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoginB = resolve;
        }),
    );
    vi.mocked(rotateSessionOwnerNonce).mockResolvedValue("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const restoreSpy = vi.spyOn(sleepWidget, "restoreSleepWidgetWriter");

    let login: Promise<void> | undefined;
    await act(async () => {
      login = result.current.onLoginSuccess("token-b");
      await Promise.resolve();
    });
    await waitFor(() => expect(finishLoginB).toBeTypeOf("function"));

    const fetchesBeforeRetry = vi.mocked(fetchCurrentUser).mock.calls.length;
    await act(async () => {
      appStateListeners.at(-1)?.("active");
      await Promise.resolve();
    });
    expect(vi.mocked(fetchCurrentUser).mock.calls.length).toBe(fetchesBeforeRetry);

    await act(async () => {
      finishLoginB?.(userB);
      await login;
    });
    expect(result.current.user).toEqual(userB);
    expect(result.current.sessionToken).toBe("token-b");
    expect(restoreSpy).toHaveBeenCalledWith("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("keeps the writer retired and writes the signed-out marker when interactive login gets a null user", async () => {
    const { getSessionToken, fetchCurrentUser, rotateSessionOwnerNonce } = await importAuthApis();
    vi.mocked(getSessionToken).mockResolvedValue("existing-token");
    vi.mocked(fetchCurrentUser).mockResolvedValue(defaultUser);
    vi.mocked(rotateSessionOwnerNonce).mockResolvedValue("11111111-1111-4111-8111-111111111111");
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user).toEqual(defaultUser));

    const order: string[] = [];
    vi.spyOn(sleepWidget, "removeSleepWidgetSnapshot").mockImplementation(() => {
      order.push("remove");
    });
    vi.spyOn(sleepWidget, "retireSleepWidgetWriter").mockImplementation(() => {
      order.push("retire");
    });
    const restoreSpy = vi.spyOn(sleepWidget, "restoreSleepWidgetWriter").mockClear();
    vi.spyOn(sleepWidget, "writeSleepWidgetSignedOutMarker").mockImplementation(() => {
      order.push("marker");
    });
    vi.mocked(fetchCurrentUser).mockResolvedValue(null);

    await act(async () => {
      await result.current.onLoginSuccess("revoked-token");
    });

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(order.indexOf("remove")).toBeLessThan(order.indexOf("retire"));
    expect(order.indexOf("retire")).toBeLessThan(order.indexOf("marker"));
    expect(result.current.user).toBeNull();
  });

  it("clears the widget on confirmed session loss and preserves it on transient failure", async () => {
    const { getSessionToken, fetchCurrentUser } = await importAuthApis();
    const removeSpy = vi.spyOn(sleepWidget, "removeSleepWidgetSnapshot");
    const markerSpy = vi.spyOn(sleepWidget, "writeSleepWidgetSignedOutMarker");
    const restoreSpy = vi.spyOn(sleepWidget, "restoreSleepWidgetWriter");

    vi.mocked(getSessionToken).mockResolvedValue(null);
    const signedOut = renderHook(() => useAuth(), { wrapper });
    await waitForAuthLoaded(signedOut.result);
    expect(removeSpy).toHaveBeenCalled();
    expect(markerSpy).toHaveBeenCalled();
    signedOut.unmount();

    removeSpy.mockClear();
    markerSpy.mockClear();
    restoreSpy.mockClear();
    vi.mocked(getSessionToken).mockResolvedValue("persisted-token");
    mockGetSavedSessionUser.mockResolvedValue(defaultUser);
    vi.mocked(fetchCurrentUser).mockRejectedValue(new TypeError("Network request failed"));
    const transient = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(transient.result.current.isLoading).toBe(false));
    expect(transient.result.current.user).toEqual(defaultUser);
    expect(removeSpy).not.toHaveBeenCalled();
    expect(restoreSpy).toHaveBeenCalled();
    transient.unmount();
  });
});
