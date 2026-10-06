import { focusManager, onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import type { NetworkState } from "expo-network";
import { AppState, type AppStateStatus, Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerMobileQueryLifecycle } from "./mobile-query-lifecycle";

const network = vi.hoisted(() => ({
  get: vi.fn<() => Promise<NetworkState>>(),
  listen: vi.fn(),
  remove: vi.fn(),
  capture: vi.fn(),
}));
vi.mock("expo-network", () => ({
  getNetworkStateAsync: network.get,
  addNetworkStateListener: network.listen,
}));
vi.mock("./telemetry", () => ({ captureException: network.capture }));

let appListener: (state: AppStateStatus) => void;
let networkListener: (state: NetworkState) => void;
let removeApp: ReturnType<typeof vi.fn>;
let cleanup: (() => void) | undefined;
let stopObserver: (() => void) | undefined;
let client: QueryClient;

function pollingQuery() {
  const fetch = vi.fn(async () => "alerts");
  const observer = new QueryObserver(client, {
    queryKey: ["processing.alerts"],
    queryFn: fetch,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    initialData: "cached alerts",
    initialDataUpdatedAt: Date.now(),
    staleTime: 60_000,
  });
  stopObserver = observer.subscribe(() => undefined);
  return fetch;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  AppState.currentState = "active";
  Platform.OS = "ios";
  focusManager.setFocused(true);
  onlineManager.setOnline(true);
  removeApp = vi.fn();
  vi.mocked(AppState.addEventListener).mockImplementation((_event, listener) => {
    appListener = listener;
    return { remove: removeApp };
  });
  network.listen.mockImplementation((listener: typeof networkListener) => {
    networkListener = listener;
    return { remove: network.remove };
  });
  network.get.mockResolvedValue({ isConnected: true, isInternetReachable: true });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.mount();
});
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  stopObserver?.();
  stopObserver = undefined;
  client.unmount();
  client.clear();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  vi.useRealTimers();
});

describe("registerMobileQueryLifecycle", () => {
  it("stops initial background polling and recovers in the foreground", async () => {
    AppState.currentState = "background";
    cleanup = registerMobileQueryLifecycle();
    const fetch = pollingQuery();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).not.toHaveBeenCalled();
    appListener("active");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops foreground polling when the app backgrounds", async () => {
    cleanup = registerMobileQueryLifecycle();
    const fetch = pollingQuery();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledOnce();
    appListener("inactive");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).toHaveBeenCalledOnce();
    appListener("active");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("pauses initial offline polling and resumes after reconnect", async () => {
    network.get.mockResolvedValue({ isConnected: false, isInternetReachable: false });
    cleanup = registerMobileQueryLifecycle();
    const fetch = pollingQuery();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).not.toHaveBeenCalled();
    networkListener({ isConnected: true, isInternetReachable: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("pauses disconnects and resumes on recovery", async () => {
    cleanup = registerMobileQueryLifecycle();
    const fetch = pollingQuery();
    await vi.advanceTimersByTimeAsync(15_000);
    networkListener({ isConnected: true, isInternetReachable: false });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).toHaveBeenCalledOnce();
    networkListener({ isConnected: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not overwrite a newer disconnect with a stale initial probe", async () => {
    let resolve: (state: NetworkState) => void = () => undefined;
    network.get.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    cleanup = registerMobileQueryLifecycle();
    const fetch = pollingQuery();
    networkListener({ isConnected: false });
    resolve({ isConnected: true });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("removes subscriptions and ignores an initial probe completed after cleanup", async () => {
    let resolve: (state: NetworkState) => void = () => undefined;
    network.get.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    cleanup = registerMobileQueryLifecycle();
    cleanup();
    cleanup = undefined;
    onlineManager.setOnline(false);
    focusManager.setFocused(false);
    appListener("active");
    networkListener({ isConnected: true });
    resolve({ isConnected: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(removeApp).toHaveBeenCalledOnce();
    expect(network.remove).toHaveBeenCalledOnce();
    expect(onlineManager.isOnline()).toBe(false);
    expect(focusManager.isFocused()).toBe(false);
  });

  it("reports initial probe failures without arbitrary native messages", async () => {
    network.get.mockRejectedValue(new Error("private token and record details"));
    cleanup = registerMobileQueryLifecycle();
    const fetch = pollingQuery();
    await vi.advanceTimersByTimeAsync(1);
    expect(network.capture).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Unable to read mobile network state" }),
      { source: "mobile-query-network-state", failureKind: "error" },
    );
    expect(JSON.stringify(network.capture.mock.calls)).not.toContain("private token");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledOnce();
    networkListener({ isConnected: true });
    expect(onlineManager.isOnline()).toBe(true);
  });

  it("keeps browser lifecycle defaults on web", () => {
    Platform.OS = "web";
    cleanup = registerMobileQueryLifecycle();
    expect(AppState.addEventListener).not.toHaveBeenCalled();
    expect(network.listen).not.toHaveBeenCalled();
    expect(focusManager.isFocused()).toBe(true);
    expect(onlineManager.isOnline()).toBe(true);
  });
});
