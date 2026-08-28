// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { purgeWebAccountState } from "./account-erasure-purge.ts";
import {
  loadAnyAccountErasurePreparation,
  saveAccountErasurePreparation,
} from "./account-erasure-storage.ts";
import { AuthProvider, useAuth } from "./auth-context.tsx";
import { installTestWebAccountStateLocks } from "./web-account-state-lock.test-helpers.ts";

const mockFetchCurrentUser = vi.hoisted(() => vi.fn());
const mockLogout = vi.hoisted(() => vi.fn());
const mockIdentify = vi.hoisted(() => vi.fn());
const mockReset = vi.hoisted(() => vi.fn());
const mockClearPreparation = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());
const mockIdentifyUser = vi.hoisted(() => vi.fn());
const mockResetUser = vi.hoisted(() => vi.fn());
const mockRedirectToLogin = vi.hoisted(() => vi.fn());

vi.mock("./auth.ts", () => ({
  fetchCurrentUser: mockFetchCurrentUser,
  logout: mockLogout,
  redirectToLogin: mockRedirectToLogin,
}));

vi.mock("./posthog.ts", () => ({
  identifyPostHogUser: mockIdentify,
  resetPostHogUser: mockReset,
}));

vi.mock("./account-erasure-storage.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./account-erasure-storage.ts")>()),
  clearAccountErasurePreparation: mockClearPreparation,
}));

vi.mock("./telemetry.ts", () => ({
  captureException: mockCaptureException,
  identifyUser: mockIdentifyUser,
  resetUser: mockResetUser,
}));

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe("web auth account identity", () => {
  beforeEach(() => {
    installTestWebAccountStateLocks();
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchCurrentUser.mockResolvedValue({
      email: "test@example.com",
      id: "user-1",
      name: "Test",
    });
    mockLogout.mockResolvedValue(undefined);
  });

  it("identifies the authenticated account", async () => {
    renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(mockIdentify).toHaveBeenCalledWith("user-1"));
  });

  it("holds a global cleanup gate while clearing the erased account's local auth state", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-1"));

    let cleanupLease:
      | Awaited<ReturnType<typeof result.current.beginAccountErasureCleanup>>
      | undefined;
    await act(async () => {
      cleanupLease = await result.current.beginAccountErasureCleanup("user-1");
    });

    expect(result.current.user).toBeNull();
    expect(result.current.accountErasureCleanupInProgress).toBe(true);
    expect(mockLogout).not.toHaveBeenCalled();
    expect(mockReset).toHaveBeenCalled();

    act(() => {
      if (!cleanupLease) throw new Error("Cleanup lease was not created.");
      result.current.finishAccountErasureCleanup(cleanupLease);
    });
    expect(result.current.accountErasureCleanupInProgress).toBe(false);
  });

  it("clears an unused preparation capability during normal logout", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-1"));

    await act(async () => result.current.logout());

    expect(mockClearPreparation).toHaveBeenCalledOnce();
  });

  it("preserves a different active account and rejects the old account's cleanup", async () => {
    mockFetchCurrentUser.mockResolvedValue({
      email: "second@example.com",
      id: "user-2",
      name: "Second User",
    });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-2"));

    let cleanupError: unknown;
    await act(async () => {
      try {
        await result.current.beginAccountErasureCleanup("user-1");
      } catch (error: unknown) {
        cleanupError = error;
      }
    });
    expect(cleanupError).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/another account became active/i) }),
    );
    expect(result.current.user?.id).toBe("user-2");
    expect(result.current.accountErasureCleanupInProgress).toBe(false);
    expect(mockLogout).not.toHaveBeenCalled();
  });

  it("keeps the matching lease through same-owner storage purge but invalidates it on rotation", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-1"));
    const ownerNonce = result.current.accountSessionOwnerNonce;
    if (!ownerNonce) throw new Error("Session owner nonce was not created.");

    let cleanupLease:
      | Awaited<ReturnType<typeof result.current.beginAccountErasureCleanup>>
      | undefined;
    await act(async () => {
      cleanupLease = await result.current.beginAccountErasureCleanup("user-1");
    });
    if (!cleanupLease) throw new Error("Cleanup lease was not created.");
    const activeCleanupLease = cleanupLease;

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "dofek:session-owner-nonce:v1",
          oldValue: ownerNonce,
          newValue: null,
        }),
      );
    });
    expect(result.current.isAccountErasureCleanupLeaseCurrent(activeCleanupLease)).toBe(true);

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "dofek:session-owner-nonce:v1",
          oldValue: ownerNonce,
          newValue: "33333333-3333-4333-8333-333333333333",
        }),
      );
    });
    expect(result.current.isAccountErasureCleanupLeaseCurrent(activeCleanupLease)).toBe(false);
    act(() => result.current.finishAccountErasureCleanup(activeCleanupLease));
  });

  it("lets a second tab for the same authoritative user adopt the existing cleanup nonce", async () => {
    const firstTab = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(firstTab.result.current.user?.id).toBe("user-1"));
    const ownerNonce = firstTab.result.current.accountSessionOwnerNonce;
    if (!ownerNonce) throw new Error("Session owner nonce was not created.");
    saveAccountErasurePreparation({
      cleanupOwnerNonce: ownerNonce,
      confirmationAttemptedAt: "2026-07-26T12:05:00.000Z",
      expiresAt: "2026-07-26T12:15:00.000Z",
      preparationToken: "p".repeat(43),
    });

    const secondTab = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(secondTab.result.current.user?.id).toBe("user-1"));

    expect(secondTab.result.current.accountSessionOwnerNonce).toBe(ownerNonce);
    expect(loadAnyAccountErasurePreparation()).toEqual(
      expect.objectContaining({ cleanupOwnerNonce: ownerNonce }),
    );
  });

  it("rotates the cleanup nonce on a demonstrated account transition", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-1"));
    const firstOwnerNonce = result.current.accountSessionOwnerNonce;
    mockFetchCurrentUser.mockResolvedValue({
      email: "second@example.com",
      id: "user-2",
      name: "Second User",
    });

    await act(async () => result.current.retryBootstrap());

    expect(result.current.user?.id).toBe("user-2");
    expect(result.current.accountSessionOwnerNonce).not.toBe(firstOwnerNonce);
  });

  it("reports bootstrap failures and clears the error after a successful retry", async () => {
    const bootstrapError = new Error("Session lookup failed");
    mockFetchCurrentUser.mockRejectedValueOnce(bootstrapError).mockResolvedValueOnce({
      email: "test@example.com",
      id: "user-1",
      name: "Test",
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.bootstrapError).toBe("Session lookup failed");
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockCaptureException).toHaveBeenCalledWith(bootstrapError, { source: "auth-bootstrap" });

    await act(async () => result.current.retryBootstrap());

    expect(result.current.bootstrapError).toBeNull();
    expect(result.current.user?.id).toBe("user-1");
  });

  it("shows non-Error bootstrap failures to the user", async () => {
    mockFetchCurrentUser.mockRejectedValueOnce("Session lookup unavailable");

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.bootstrapError).toBe("Session lookup unavailable");
      expect(result.current.isLoading).toBe(false);
    });
    expect(mockCaptureException).toHaveBeenCalledWith("Session lookup unavailable", {
      source: "auth-bootstrap",
    });
  });

  it("ignores unrelated storage events", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-1"));
    const ownerNonce = result.current.accountSessionOwnerNonce;

    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "unrelated-key",
          newValue: "new-value",
          oldValue: "old-value",
        }),
      );
    });

    expect(result.current.accountSessionOwnerNonce).toBe(ownerNonce);
  });

  it("rejects cleanup continuation after another account becomes authoritative", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-1"));
    const ownerNonce = result.current.accountSessionOwnerNonce;
    if (!ownerNonce) throw new Error("Session owner nonce was not created.");
    mockFetchCurrentUser.mockResolvedValue({
      email: "second@example.com",
      id: "user-2",
      name: "Second User",
    });

    await expect(
      act(async () => result.current.beginAccountErasureCleanupForNonce(ownerNonce)),
    ).rejects.toThrow(/another account became active/i);

    expect(result.current.accountErasureCleanupInProgress).toBe(false);
  });

  it("rejects cleanup continuation when its persisted owner nonce is stale", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-1"));

    await expect(
      act(async () => result.current.beginAccountErasureCleanupForNonce("stale-owner-nonce")),
    ).rejects.toThrow(/another account became active/i);

    expect(result.current.accountErasureCleanupInProgress).toBe(false);
  });

  it("continues cleanup after the authoritative session has ended", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-1"));
    const ownerNonce = result.current.accountSessionOwnerNonce;
    if (!ownerNonce) throw new Error("Session owner nonce was not created.");
    mockFetchCurrentUser.mockResolvedValue(null);

    let cleanupLease:
      | Awaited<ReturnType<typeof result.current.beginAccountErasureCleanupForNonce>>
      | undefined;
    await act(async () => {
      cleanupLease = await result.current.beginAccountErasureCleanupForNonce(ownerNonce);
    });

    expect(result.current.user).toBeNull();
    expect(result.current.accountErasureCleanupInProgress).toBe(true);
    if (!cleanupLease) throw new Error("Cleanup lease was not created.");
    const activeCleanupLease = cleanupLease;
    act(() => result.current.finishAccountErasureCleanup(activeCleanupLease));
  });

  it("does not let a stale cleanup lease finish the active cleanup", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.user?.id).toBe("user-1"));

    let cleanupLease:
      | Awaited<ReturnType<typeof result.current.beginAccountErasureCleanup>>
      | undefined;
    await act(async () => {
      cleanupLease = await result.current.beginAccountErasureCleanup("user-1");
    });
    if (!cleanupLease) throw new Error("Cleanup lease was not created.");
    const activeCleanupLease = cleanupLease;

    act(() => result.current.finishAccountErasureCleanup({ ...activeCleanupLease }));
    expect(result.current.accountErasureCleanupInProgress).toBe(true);

    act(() => result.current.finishAccountErasureCleanup(activeCleanupLease));
    expect(result.current.accountErasureCleanupInProgress).toBe(false);
  });

  it("serializes a later account adoption after the prior owner's destructive purge", async () => {
    const firstTab = renderHook(() => useAuth(), { wrapper });
    const secondTab = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => {
      expect(firstTab.result.current.user?.id).toBe("user-1");
      expect(secondTab.result.current.user?.id).toBe("user-1");
    });

    let cleanupLease:
      | Awaited<ReturnType<typeof firstTab.result.current.beginAccountErasureCleanup>>
      | undefined;
    await act(async () => {
      cleanupLease = await firstTab.result.current.beginAccountErasureCleanup("user-1");
    });
    if (!cleanupLease) throw new Error("Cleanup lease was not created.");
    const activeCleanupLease = cleanupLease;

    mockFetchCurrentUser.mockResolvedValue({
      email: "second@example.com",
      id: "user-2",
      name: "Second User",
    });
    const fetchCountBeforeQueuedAdoption = mockFetchCurrentUser.mock.calls.length;
    let adoptionFinished = false;
    let adoption: Promise<void> | undefined;
    act(() => {
      adoption = secondTab.result.current.retryBootstrap().then(() => {
        adoptionFinished = true;
      });
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(adoptionFinished).toBe(false);
    expect(mockFetchCurrentUser).toHaveBeenCalledTimes(fetchCountBeforeQueuedAdoption);
    localStorage.setItem("user-1-dashboard-cache", "private");
    await purgeWebAccountState({
      cleanupLease: activeCleanupLease,
      isCleanupLeaseCurrent: firstTab.result.current.isAccountErasureCleanupLeaseCurrent,
      localStorage,
      notifyOtherTabs: false,
      purgeUploads: vi.fn().mockResolvedValue(undefined),
      queryClient: { clear: vi.fn() },
      sessionStorage,
    });
    expect(localStorage.getItem("user-1-dashboard-cache")).toBeNull();
    expect(adoptionFinished).toBe(false);

    act(() => {
      firstTab.result.current.finishAccountErasureCleanup(activeCleanupLease);
    });
    await act(async () => adoption);

    expect(secondTab.result.current.user?.id).toBe("user-2");
    expect(secondTab.result.current.accountSessionOwnerNonce).not.toBe(
      activeCleanupLease.cleanupOwnerNonce,
    );
  });
});

describe("AuthProvider analytics identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("identifies the authenticated user after bootstrap", async () => {
    const { fetchCurrentUser } = await import("./auth.ts");
    const user = {
      id: "user-123",
      name: "Alice Example",
      email: "alice@example.com",
    };
    vi.mocked(fetchCurrentUser).mockResolvedValue(user);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.user).toEqual(user);
    });

    expect(mockIdentifyUser).toHaveBeenCalledOnce();
    expect(mockIdentifyUser).toHaveBeenCalledWith(user);
    expect(mockResetUser).not.toHaveBeenCalled();
  });

  it("does not identify or reset an unauthenticated visitor during bootstrap", async () => {
    const { fetchCurrentUser } = await import("./auth.ts");
    vi.mocked(fetchCurrentUser).mockResolvedValue(null);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockIdentifyUser).not.toHaveBeenCalled();
    expect(mockResetUser).not.toHaveBeenCalled();
  });

  it("resets the analytics identity after logout succeeds", async () => {
    const { fetchCurrentUser, logout } = await import("./auth.ts");
    vi.mocked(fetchCurrentUser).mockResolvedValue({
      id: "user-123",
      name: "Alice Example",
      email: "alice@example.com",
    });
    vi.mocked(logout).mockResolvedValue();

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await act(async () => {
      await result.current.logout();
    });

    expect(mockResetUser).toHaveBeenCalledOnce();
    expect(vi.mocked(logout).mock.invocationCallOrder[0]).toBeLessThan(
      mockResetUser.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mockResetUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockRedirectToLogin.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("preserves the analytics identity when logout fails", async () => {
    const { fetchCurrentUser, logout } = await import("./auth.ts");
    const error = new Error("Network unavailable");
    vi.mocked(fetchCurrentUser).mockResolvedValue({
      id: "user-123",
      name: "Alice Example",
      email: "alice@example.com",
    });
    vi.mocked(logout).mockRejectedValue(error);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => {
      expect(result.current.user).not.toBeNull();
    });

    await expect(
      act(async () => {
        await result.current.logout();
      }),
    ).rejects.toThrow("Network unavailable");

    expect(mockResetUser).not.toHaveBeenCalled();
    expect(mockRedirectToLogin).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(error, { source: "logout" });
    expect(result.current.user?.id).toBe("user-123");
  });

  it("resets when an identified session becomes unauthenticated", async () => {
    const { fetchCurrentUser } = await import("./auth.ts");
    vi.mocked(fetchCurrentUser)
      .mockResolvedValueOnce({
        id: "user-123",
        name: "Alice Example",
        email: "alice@example.com",
      })
      .mockResolvedValueOnce(null);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => {
      expect(result.current.user?.id).toBe("user-123");
    });

    await act(async () => {
      await result.current.retryBootstrap();
    });

    expect(result.current.user).toBeNull();
    expect(mockResetUser).toHaveBeenCalledOnce();
  });

  it("resets before identifying a different authenticated user", async () => {
    const { fetchCurrentUser } = await import("./auth.ts");
    vi.mocked(fetchCurrentUser)
      .mockResolvedValueOnce({
        id: "user-123",
        name: "Alice Example",
        email: "alice@example.com",
      })
      .mockResolvedValueOnce({
        id: "user-456",
        name: "Bob Example",
        email: "bob@example.com",
      });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => {
      expect(result.current.user?.id).toBe("user-123");
    });

    await act(async () => {
      await result.current.retryBootstrap();
    });

    expect(result.current.user?.id).toBe("user-456");
    expect(mockResetUser).toHaveBeenCalledOnce();
    expect(mockResetUser.mock.invocationCallOrder[0]).toBeLessThan(
      mockIdentifyUser.mock.invocationCallOrder[1] ?? 0,
    );
  });
});
