// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  captureException: vi.fn(),
  info: vi.fn(),
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

vi.mock("./telemetry", () => ({
  captureException: mocks.captureException,
  logger: { info: mocks.info },
}));

import { useCollectionNotifications } from "./useCollectionNotifications";

const currentAdmission = {
  sessionOwnerNonce: "owner-a",
  isCurrentSessionOwner: (nonce: string | null) => nonce === "owner-a",
};

describe("useCollectionNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appState = "active";
    mocks.enable.mockResolvedValue(true);
  });

  it("enables notification permission and monitoring for an active signed-in session", () => {
    renderHook(() => useCollectionNotifications(true, currentAdmission));
    expect(mocks.enable).toHaveBeenCalledOnce();
    expect(mocks.enable).toHaveBeenCalledWith(true);
  });

  it("enables existing authorization during a background launch without prompting", () => {
    mocks.appState = "background";
    renderHook(() => useCollectionNotifications(true, currentAdmission));
    expect(mocks.enable).toHaveBeenCalledWith(false);
  });

  it("does not record completion until the native check settles", async () => {
    let resolvePermission: (granted: boolean) => void = () => {};
    mocks.enable.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePermission = resolve;
      }),
    );
    renderHook(() => useCollectionNotifications(true, currentAdmission));

    await act(async () => {});
    expect(mocks.info).not.toHaveBeenCalled();

    await act(async () => resolvePermission(true));
    expect(mocks.info).toHaveBeenCalledOnce();
  });

  it("records a completed check when notification access is granted", async () => {
    renderHook(() => useCollectionNotifications(true, currentAdmission));

    await waitFor(() => expect(mocks.info).toHaveBeenCalledOnce());
    expect(mocks.info).toHaveBeenCalledWith(
      "collection-notifications",
      "Native collection notification check completed",
      {
        event: "collection_notifications_enable_completed",
        requestPermission: true,
        granted: true,
      },
    );
  });

  it("records a completed denied check from a background launch without prompting", async () => {
    mocks.appState = "background";
    mocks.enable.mockResolvedValue(false);
    renderHook(() => useCollectionNotifications(true, currentAdmission));

    await waitFor(() => expect(mocks.info).toHaveBeenCalledOnce());
    expect(mocks.info).toHaveBeenCalledWith(
      "collection-notifications",
      "Native collection notification check completed",
      {
        event: "collection_notifications_enable_completed",
        requestPermission: false,
        granted: false,
      },
    );
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("requests permission when a background launch later becomes active", async () => {
    mocks.appState = "background";
    renderHook(() => useCollectionNotifications(true, currentAdmission));
    await act(async () => {});

    act(() => mocks.onAppState("active"));
    expect(mocks.enable).toHaveBeenLastCalledWith(true);
  });

  it("disables both alerts when the authenticated session ends", () => {
    const { rerender } = renderHook(
      ({ enabled }) => useCollectionNotifications(enabled, currentAdmission),
      {
        initialProps: { enabled: true },
      },
    );
    rerender({ enabled: false });
    expect(mocks.disable).toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("preserves native alerts while removing its JS listener on unmount", () => {
    const { unmount } = renderHook(() => useCollectionNotifications(true, currentAdmission));
    unmount();
    expect(mocks.disable).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("preserves pending native alerts while session readiness is unresolved", () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean | undefined }) =>
        useCollectionNotifications(enabled, currentAdmission),
      {
        initialProps: { enabled: undefined },
      },
    );

    expect(mocks.disable).not.toHaveBeenCalled();
    expect(mocks.enable).not.toHaveBeenCalled();
    rerender({ enabled: true });
    expect(mocks.enable).toHaveBeenCalledWith(true);
    rerender({ enabled: undefined });
    expect(mocks.disable).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledOnce();
  });

  it("does not ask for permission while monitoring is disabled", () => {
    renderHook(() => useCollectionNotifications(false, currentAdmission));
    expect(mocks.disable).toHaveBeenCalledOnce();
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it("reports unexpected permission failures and shows their actionable message", async () => {
    const error = new Error("Notification authorization could not be loaded. Open iOS Settings.");
    mocks.enable.mockRejectedValue(error);
    renderHook(() => useCollectionNotifications(true, currentAdmission));

    await waitFor(() =>
      expect(mocks.captureException).toHaveBeenCalledWith(error, {
        source: "collection-notifications-enable",
      }),
    );
    expect(mocks.alert).toHaveBeenCalledWith("Notifications unavailable", error.message);
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("explains denied collection notifications once while authorization remains denied", async () => {
    mocks.enable.mockResolvedValue(false);
    renderHook(() => useCollectionNotifications(true, currentAdmission));

    await waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());
    expect(mocks.alert).toHaveBeenCalledWith(
      "Notifications unavailable",
      expect.stringContaining("iOS Settings"),
    );
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith(
      "collection-notifications",
      "Native collection notification check completed",
      {
        event: "collection_notifications_enable_completed",
        requestPermission: true,
        granted: false,
      },
    );

    await act(async () => mocks.onAppState("active"));
    expect(mocks.alert).toHaveBeenCalledOnce();
  });

  it("shows denial guidance after a background launch reaches the foreground", async () => {
    mocks.appState = "background";
    mocks.enable.mockResolvedValue(false);
    renderHook(() => useCollectionNotifications(true, currentAdmission));

    await act(async () => {});
    expect(mocks.alert).not.toHaveBeenCalled();

    await act(async () => {
      mocks.appState = "active";
      mocks.onAppState("active");
    });
    expect(mocks.alert).toHaveBeenCalledOnce();
  });

  it("does not show a permission denial after the app backgrounds", async () => {
    let resolvePermission: (granted: boolean) => void = () => {};
    mocks.enable.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePermission = resolve;
      }),
    );
    renderHook(() => useCollectionNotifications(true, currentAdmission));

    mocks.appState = "background";
    await act(async () => resolvePermission(false));
    expect(mocks.alert).not.toHaveBeenCalled();
  });

  it("does not show a permission denial after the authenticated session ends", async () => {
    let resolvePermission: (granted: boolean) => void = () => {};
    mocks.enable.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePermission = resolve;
      }),
    );
    const { rerender } = renderHook(
      ({ enabled }) => useCollectionNotifications(enabled, currentAdmission),
      {
        initialProps: { enabled: true },
      },
    );

    rerender({ enabled: false });
    await act(async () => resolvePermission(false));
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("ignores stale denial results after a newer foreground check succeeds", async () => {
    let resolvePermission: (granted: boolean) => void = () => {};
    mocks.enable.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolvePermission = resolve;
      }),
    );
    renderHook(() => useCollectionNotifications(true, currentAdmission));

    await act(async () => mocks.onAppState("active"));
    await act(async () => resolvePermission(false));
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledOnce();
    expect(mocks.info).toHaveBeenCalledWith(
      "collection-notifications",
      "Native collection notification check completed",
      {
        event: "collection_notifications_enable_completed",
        requestPermission: true,
        granted: true,
      },
    );
  });

  it("can explain a new denial after notification access was restored", async () => {
    mocks.enable.mockResolvedValue(false);
    renderHook(() => useCollectionNotifications(true, currentAdmission));
    await waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());

    mocks.enable.mockResolvedValueOnce(true);
    await act(async () => mocks.onAppState("active"));
    await act(async () => mocks.onAppState("active"));
    expect(mocks.alert).toHaveBeenCalledTimes(2);
  });

  it("ignores a permission failure after the session has ended", async () => {
    let rejectPermission: (error: Error) => void = () => {};
    mocks.enable.mockReturnValue(
      new Promise<boolean>((_resolve, reject) => {
        rejectPermission = reject;
      }),
    );
    const { unmount } = renderHook(() => useCollectionNotifications(true, currentAdmission));
    unmount();
    await act(async () => rejectPermission(new Error("authorization interrupted")));
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.captureException).toHaveBeenCalledOnce();
    expect(mocks.info).not.toHaveBeenCalled();
  });

  it("ignores an AppState enable after session ownership is invalidated before rerender", async () => {
    let ownershipValid = true;
    const admission = {
      sessionOwnerNonce: "owner-a",
      isCurrentSessionOwner: (nonce: string | null) => ownershipValid && nonce === "owner-a",
    };
    renderHook(() => useCollectionNotifications(true, admission));
    expect(mocks.enable).toHaveBeenCalledOnce();

    ownershipValid = false;
    mocks.enable.mockClear();
    act(() => mocks.onAppState("active"));
    expect(mocks.enable).not.toHaveBeenCalled();
  });

  it("does not let a retired listener use the replacement owner's authorization", () => {
    let currentOwner = "owner-a";
    const isCurrentSessionOwner = (nonce: string | null) => nonce === currentOwner;
    const { rerender } = renderHook(
      ({ sessionOwnerNonce }) =>
        useCollectionNotifications(true, { sessionOwnerNonce, isCurrentSessionOwner }),
      { initialProps: { sessionOwnerNonce: currentOwner } },
    );
    const retiredListener = mocks.onAppState;

    currentOwner = "owner-b";
    rerender({ sessionOwnerNonce: currentOwner });
    mocks.enable.mockClear();

    act(() => retiredListener("active"));
    expect(mocks.enable).not.toHaveBeenCalled();
    act(() => mocks.onAppState("active"));
    expect(mocks.enable).toHaveBeenCalledOnce();
  });

  it("ignores a granted enable result after ownership is invalidated", async () => {
    let resolvePermission: (granted: boolean) => void = () => {};
    mocks.enable.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolvePermission = resolve;
      }),
    );
    let ownershipValid = true;
    const admission = {
      sessionOwnerNonce: "owner-a",
      isCurrentSessionOwner: (nonce: string | null) => ownershipValid && nonce === "owner-a",
    };
    renderHook(() => useCollectionNotifications(true, admission));

    ownershipValid = false;
    await act(async () => resolvePermission(true));
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.alert).not.toHaveBeenCalled();
  });
});
