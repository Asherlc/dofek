// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  captureException: vi.fn(),
  alert: vi.fn(),
  remove: vi.fn(),
  appState: "active",
  onAppState: (_state: string) => {},
}));

vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  AppState: {
    get currentState() {
      return mocks.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      mocks.onAppState = listener;
      return { remove: mocks.remove };
    },
  },
}));

vi.mock("../modules/background-refresh", () => ({
  enableCollectionNotifications: mocks.enable,
  disableCollectionNotifications: mocks.disable,
}));

vi.mock("./telemetry", () => ({ captureException: mocks.captureException }));

import { useCollectionNotifications } from "./useCollectionNotifications";

describe("useCollectionNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appState = "active";
    mocks.enable.mockResolvedValue(true);
  });

  it("enables notification permission and monitoring for an active signed-in session", () => {
    renderHook(() => useCollectionNotifications(true));
    expect(mocks.enable).toHaveBeenCalledOnce();
    expect(mocks.enable).toHaveBeenCalledWith(true);
  });

  it("enables existing authorization during a background launch without prompting", () => {
    mocks.appState = "background";
    renderHook(() => useCollectionNotifications(true));
    expect(mocks.enable).toHaveBeenCalledWith(false);
  });

  it("requests permission when a background launch later becomes active", async () => {
    mocks.appState = "background";
    renderHook(() => useCollectionNotifications(true));
    await act(async () => {});

    act(() => mocks.onAppState("active"));
    expect(mocks.enable).toHaveBeenLastCalledWith(true);
  });

  it("disables both alerts when the authenticated session ends", () => {
    const { rerender } = renderHook(({ enabled }) => useCollectionNotifications(enabled), {
      initialProps: { enabled: true },
    });
    rerender({ enabled: false });
    expect(mocks.disable).toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("removes monitoring and its listener on unmount", () => {
    const { unmount } = renderHook(() => useCollectionNotifications(true));
    unmount();
    expect(mocks.disable).toHaveBeenCalledOnce();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("does not ask for permission while monitoring is disabled", () => {
    renderHook(() => useCollectionNotifications(false));
    expect(mocks.disable).toHaveBeenCalledOnce();
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it("reports unexpected permission failures and shows their actionable message", async () => {
    const error = new Error("Notification authorization could not be loaded. Open iOS Settings.");
    mocks.enable.mockRejectedValue(error);
    renderHook(() => useCollectionNotifications(true));

    await waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(error, {
        source: "collection-notifications-enable",
      }),
    );
    expect(mocks.alert).toHaveBeenCalledWith("Notifications unavailable", error.message);
  });

  it("ignores a permission failure after the session has ended", async () => {
    let rejectPermission: (error: Error) => void = () => {};
    mocks.enable.mockReturnValue(
      new Promise<boolean>((_resolve, reject) => {
        rejectPermission = reject;
      }),
    );
    const { unmount } = renderHook(() => useCollectionNotifications(true));
    unmount();
    await act(async () => rejectPermission(new Error("authorization interrupted")));
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });
});
