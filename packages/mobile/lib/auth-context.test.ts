import { onlineManager } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { AppState } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth-context";

const mockRemoveMobileQueryCache = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockClearAccountErasurePreparation = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const mockGetSavedSessionUser = vi.hoisted(() => vi.fn());
const mockSaveSessionUser = vi.hoisted(() => vi.fn(() => Promise.resolve()));

// expo-secure-store, expo-web-browser, expo-apple-authentication, and react-native
// are mocked globally in test-setup.ts

vi.mock("./mobile-query-persistence", () => ({
  removeMobileQueryCache: mockRemoveMobileQueryCache,
}));

vi.mock("./account-erasure-storage", () => ({
  clearMobileAccountErasurePreparation: mockClearAccountErasurePreparation,
}));

const mockCaptureException = vi.hoisted(() => vi.fn());
const mockIdentifyUser = vi.hoisted(() => vi.fn());
const mockResetUser = vi.hoisted(() => vi.fn());
const { mockStartStartupPhase, mockFinishStartupPhase } = vi.hoisted(() => ({
  mockStartStartupPhase: vi.fn(),
  mockFinishStartupPhase: vi.fn(),
}));

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
  identifyUser: mockIdentifyUser,
  resetUser: mockResetUser,
}));

vi.mock("./startup-telemetry", () => ({
  startStartupPhase: mockStartStartupPhase,
  finishStartupPhase: mockFinishStartupPhase,
}));

vi.mock("./auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth")>();
  return {
    ...original,
    logout: vi.fn(() => Promise.resolve()),
    clearSessionToken: vi.fn(() => Promise.resolve()),
    createAccountErasureCleanupNonce: vi.fn(() => "22222222-2222-4222-8222-222222222222"),
    getSessionToken: vi.fn(() => Promise.resolve(null)),
    invalidateSessionPersistence: vi.fn(),
    rotateSessionOwnerNonce: vi.fn(() => Promise.resolve("11111111-1111-4111-8111-111111111111")),
    saveSessionToken: vi.fn(() => Promise.resolve()),
    getSavedSessionUser: mockGetSavedSessionUser,
    saveSessionUser: mockSaveSessionUser,
    fetchCurrentUser: vi.fn(() => Promise.resolve(null)),
  };
});

function wrapper({ children }: { children: ReactNode }) {
  return createElement(AuthProvider, null, children);
}

describe("auth-context", () => {
  beforeEach(async () => {
    mockGetSavedSessionUser.mockResolvedValue(null);
    const { fetchCurrentUser } = await import("./auth");
    vi.mocked(fetchCurrentUser).mockReset().mockResolvedValue(null);
  });

  it("exports AuthProvider and useAuth", async () => {
    const mod = await import("./auth-context");
    expect(mod.AuthProvider).toBeDefined();
    expect(typeof mod.AuthProvider).toBe("function");
    expect(mod.useAuth).toBeDefined();
    expect(typeof mod.useAuth).toBe("function");
  });

  describe("session token migration", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      AppState.currentState = "active";
    });

    it("re-saves the token on mount to migrate keychain accessibility", async () => {
      const { getSessionToken, fetchCurrentUser, saveSessionToken } = await import("./auth");

      vi.mocked(getSessionToken).mockResolvedValue("existing-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });

      expect(saveSessionToken).toHaveBeenCalledWith("existing-token");
      expect(mockStartStartupPhase).toHaveBeenCalledWith("authentication");
      expect(mockFinishStartupPhase).toHaveBeenCalledWith("authentication", "authenticated");
    });

    it("does not re-save when no token exists", async () => {
      const { getSessionToken, saveSessionToken } = await import("./auth");

      vi.mocked(getSessionToken).mockResolvedValue(null);

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(saveSessionToken).not.toHaveBeenCalled();
      expect(mockFinishStartupPhase).toHaveBeenCalledWith("authentication", "unauthenticated");
      expect(mockResetUser).toHaveBeenCalledOnce();
    });

    it("finishes bootstrap on a fresh inactive launch with no token", async () => {
      const { getSessionToken, saveSessionToken } = await import("./auth");

      AppState.currentState = "inactive";
      vi.mocked(getSessionToken).mockResolvedValue(null);

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.user).toBeNull();
      expect(result.current.bootstrapError).toBeNull();
      expect(saveSessionToken).not.toHaveBeenCalled();
    });

    it("defers bootstrap when SecureStore is inaccessible in the background", async () => {
      const auth = await import("./auth");
      const { getSessionToken, saveSessionToken, fetchCurrentUser } = auth;
      const appStateListeners: Array<(state: string) => void> = [];

      AppState.currentState = "background";
      vi.mocked(AppState.addEventListener).mockImplementation((_event, listener) => {
        appStateListeners.push(listener);
        return { remove: vi.fn() };
      });
      vi.mocked(getSessionToken).mockRejectedValue(new Error("User interaction is not allowed"));

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(getSessionToken).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.isLoading).toBe(true);
      expect(saveSessionToken).not.toHaveBeenCalled();
      expect(result.current.user).toBeNull();
      expect(mockCaptureException).not.toHaveBeenCalled();
      expect(mockFinishStartupPhase).toHaveBeenCalledWith("authentication", "deferred");

      AppState.currentState = "active";
      vi.mocked(getSessionToken).mockResolvedValue("existing-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });

      await act(async () => {
        const latestListener = appStateListeners.at(-1);
        expect(latestListener).toBeDefined();
        latestListener?.("active");
      });

      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });

      expect(saveSessionToken).toHaveBeenCalledWith("existing-token");
    });

    it("reports SecureStore restore failures to Sentry in the foreground", async () => {
      const { getSessionToken } = await import("./auth");
      const error = new Error("Calling the getValueWithKeyAsync function has failed");

      AppState.currentState = "active";
      vi.mocked(getSessionToken).mockRejectedValue(error);

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.bootstrapError).toBe(
          "Calling the getValueWithKeyAsync function has failed",
        );
      });

      expect(mockCaptureException).toHaveBeenCalledWith(error, { source: "auth-state-restore" });
      expect(mockFinishStartupPhase).toHaveBeenCalledWith("authentication", "error");
    });

    it("keeps bootstrap failure separate from unauthenticated state", async () => {
      const { getSessionToken, fetchCurrentUser, clearSessionToken } = await import("./auth");

      vi.mocked(getSessionToken).mockResolvedValue("existing-token");
      vi.mocked(fetchCurrentUser).mockRejectedValue(new Error("Database unavailable"));

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.bootstrapError).toBe("Database unavailable");
      expect(result.current.user).toBeNull();
      expect(result.current.sessionToken).toBe("existing-token");
      expect(clearSessionToken).not.toHaveBeenCalled();
    });

    it("retries bootstrap from the saved token after a transient failure", async () => {
      const { getSessionToken, fetchCurrentUser } = await import("./auth");

      vi.mocked(getSessionToken).mockResolvedValue("existing-token");
      vi.mocked(fetchCurrentUser)
        .mockRejectedValueOnce(new Error("Database unavailable"))
        .mockResolvedValueOnce({
          id: "user-1",
          name: "Test User",
          email: "test@example.com",
        });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.bootstrapError).toBe("Database unavailable");
      });

      await act(async () => {
        await result.current.retryBootstrap();
      });

      expect(result.current.bootstrapError).toBeNull();
      expect(result.current.user).toEqual({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });
      expect(fetchCurrentUser).toHaveBeenCalledTimes(2);
    });

    it("revokes restored token when signing out after bootstrap failure", async () => {
      const { getSessionToken, fetchCurrentUser, logout: authLogout } = await import("./auth");

      vi.mocked(getSessionToken).mockResolvedValue("existing-token");
      vi.mocked(fetchCurrentUser).mockRejectedValue(new Error("Database unavailable"));

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.bootstrapError).toBe("Database unavailable");
      });

      await act(async () => {
        await result.current.logout();
      });

      expect(authLogout).toHaveBeenCalledWith(expect.any(String), "existing-token");
    });
  });

  describe("offline session restoration", () => {
    const savedUser = { id: "user-1", name: "Test User", email: "test@example.com" };

    beforeEach(async () => {
      vi.clearAllMocks();
      AppState.currentState = "active";
      const { getSessionToken } = await import("./auth");
      vi.mocked(getSessionToken).mockResolvedValue("existing-token");
      mockGetSavedSessionUser.mockResolvedValue(savedUser);
    });

    it("opens the saved session before server verification completes", async () => {
      const { fetchCurrentUser } = await import("./auth");
      let finishVerification: ((user: typeof savedUser) => void) | undefined;
      vi.mocked(fetchCurrentUser).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishVerification = resolve;
          }),
      );
      const { result } = renderHook(() => useAuth(), { wrapper });

      try {
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.user).toEqual(savedUser);
        expect(result.current.sessionToken).toBe("existing-token");
        expect(result.current.accountSessionOwnerNonce).not.toBeNull();
        expect(result.current.bootstrapError).toBeNull();
      } finally {
        await act(async () => finishVerification?.(savedUser));
      }
    });

    it("keeps the saved session usable when verification fails offline", async () => {
      const { fetchCurrentUser, clearSessionToken } = await import("./auth");
      const error = new TypeError("Network request failed");
      vi.mocked(fetchCurrentUser).mockRejectedValueOnce(error);
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current.isLoading).toBe(false));
      expect(result.current.user).toEqual(savedUser);
      expect(result.current.bootstrapError).toBeNull();
      expect(clearSessionToken).not.toHaveBeenCalled();
      expect(mockCaptureException).toHaveBeenCalledWith(error, { source: "auth-state-restore" });
    });

    it("clears the saved session when the server rejects the token", async () => {
      const { fetchCurrentUser, clearSessionToken } = await import("./auth");
      vi.mocked(fetchCurrentUser).mockResolvedValueOnce(null);
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(clearSessionToken).toHaveBeenCalledOnce());
      expect(result.current.user).toBeNull();
      expect(result.current.sessionToken).toBeNull();
      expect(result.current.bootstrapError).toBeNull();
    });

    it("ends a rejected session even when persisted identity cleanup fails", async () => {
      const { fetchCurrentUser, clearSessionToken } = await import("./auth");
      vi.mocked(fetchCurrentUser).mockResolvedValueOnce(null);
      vi.mocked(clearSessionToken).mockRejectedValueOnce(new Error("Keychain unavailable"));
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(mockCaptureException).toHaveBeenCalled());
      expect(result.current.user).toBeNull();
      expect(result.current.sessionToken).toBeNull();
      expect(result.current.accountSessionOwnerNonce).toBeNull();
      expect(result.current.bootstrapError).toBe("Keychain unavailable");
    });

    it("persists the verified user for the next offline launch", async () => {
      const { fetchCurrentUser } = await import("./auth");
      mockGetSavedSessionUser.mockResolvedValue(null);
      vi.mocked(fetchCurrentUser).mockResolvedValueOnce(savedUser);
      renderHook(() => useAuth(), { wrapper });

      await waitFor(() =>
        expect(mockSaveSessionUser).toHaveBeenCalledWith("existing-token", savedUser),
      );
    });

    it("rechecks the saved session when connectivity returns", async () => {
      const { fetchCurrentUser } = await import("./auth");
      onlineManager.setOnline(false);
      vi.mocked(fetchCurrentUser)
        .mockRejectedValueOnce(new TypeError("Network request failed"))
        .mockResolvedValueOnce({ ...savedUser, name: "Updated User" });
      const { result } = renderHook(() => useAuth(), { wrapper });

      try {
        await waitFor(() => expect(mockCaptureException).toHaveBeenCalled());
        await act(async () => onlineManager.setOnline(true));
        await waitFor(() => expect(result.current.user?.name).toBe("Updated User"));
        expect(result.current.isLoading).toBe(false);
        expect(result.current.bootstrapError).toBeNull();
      } finally {
        onlineManager.setOnline(true);
      }
    });

    it.each(["reconnection", "foreground"])(
      "retries a token-only bootstrap failure on %s",
      async (event) => {
        const { fetchCurrentUser } = await import("./auth");
        const appStateListeners: Array<(state: string) => void> = [];
        vi.mocked(AppState.addEventListener).mockImplementation((_event, listener) => {
          appStateListeners.push(listener);
          return { remove: vi.fn() };
        });
        mockGetSavedSessionUser.mockResolvedValue(null);
        onlineManager.setOnline(false);
        vi.mocked(fetchCurrentUser)
          .mockRejectedValueOnce(new TypeError("Network request failed"))
          .mockResolvedValueOnce(savedUser);
        const { result } = renderHook(() => useAuth(), { wrapper });

        try {
          await waitFor(() => expect(result.current.bootstrapError).not.toBeNull());
          await act(async () => {
            if (event === "reconnection") onlineManager.setOnline(true);
            else appStateListeners.at(-1)?.("active");
          });
          await waitFor(() => expect(result.current.user).toEqual(savedUser));
          expect(result.current.bootstrapError).toBeNull();
        } finally {
          onlineManager.setOnline(true);
        }
      },
    );

    it("does not restart a failed bootstrap when a new login is being verified", async () => {
      const { fetchCurrentUser } = await import("./auth");
      mockGetSavedSessionUser.mockResolvedValue(null);
      onlineManager.setOnline(false);
      let finishLogin: ((user: typeof savedUser) => void) | undefined;
      vi.mocked(fetchCurrentUser)
        .mockRejectedValueOnce(new TypeError("Network request failed"))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishLogin = resolve;
            }),
        );
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.bootstrapError).not.toBeNull());
      let login: Promise<unknown> | undefined;
      act(() => {
        login = result.current.onLoginSuccess("new-token").then(
          () => null,
          (error: unknown) => error,
        );
        onlineManager.setOnline(true);
      });
      await waitFor(() => expect(fetchCurrentUser).toHaveBeenCalledTimes(2));

      try {
        expect(fetchCurrentUser).toHaveBeenCalledTimes(2);
        expect(result.current.bootstrapError).toBeNull();
      } finally {
        await act(async () => {
          finishLogin?.(savedUser);
          await login;
        });
        onlineManager.setOnline(true);
      }
      await expect(login).resolves.toBeNull();
      expect(result.current.user).toEqual(savedUser);
      expect(result.current.sessionToken).toBe("new-token");
    });

    it("lets the current restore finish authentication telemetry after an older restore settles", async () => {
      const { fetchCurrentUser } = await import("./auth");
      mockGetSavedSessionUser.mockResolvedValue(null);
      let finishOlder: ((user: typeof savedUser) => void) | undefined;
      let finishCurrent: ((user: typeof savedUser) => void) | undefined;
      vi.mocked(fetchCurrentUser)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishOlder = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishCurrent = resolve;
            }),
        );
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(fetchCurrentUser).toHaveBeenCalledOnce());
      let retry: Promise<void> | undefined;
      act(() => {
        retry = result.current.retryBootstrap();
      });
      await waitFor(() => expect(fetchCurrentUser).toHaveBeenCalledTimes(2));

      try {
        await act(async () => finishOlder?.(savedUser));
        expect(mockFinishStartupPhase).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          finishCurrent?.(savedUser);
          await retry;
        });
      }
      expect(mockFinishStartupPhase).toHaveBeenCalledExactlyOnceWith(
        "authentication",
        "authenticated",
      );
    });

    it("finishes authentication telemetry when account cleanup supersedes a pending restore", async () => {
      const { fetchCurrentUser } = await import("./auth");
      mockGetSavedSessionUser.mockResolvedValue(null);
      let finishVerification: ((user: typeof savedUser) => void) | undefined;
      vi.mocked(fetchCurrentUser).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishVerification = resolve;
          }),
      );
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(fetchCurrentUser).toHaveBeenCalledOnce());

      try {
        act(() => {
          result.current.beginAccountErasureCleanup("user-1");
        });
        expect(mockFinishStartupPhase).toHaveBeenCalledExactlyOnceWith("authentication", "skipped");
      } finally {
        await act(async () => finishVerification?.(savedUser));
      }
    });

    it("does not replace a newer login when old verification fails", async () => {
      const { fetchCurrentUser, logout: authLogout } = await import("./auth");
      vi.mocked(authLogout).mockResolvedValue();
      let failVerification: ((error: Error) => void) | undefined;
      vi.mocked(fetchCurrentUser).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failVerification = reject;
          }),
      );
      const { result } = renderHook(() => useAuth(), { wrapper });

      try {
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        await act(async () => result.current.logout());
        vi.mocked(fetchCurrentUser).mockResolvedValueOnce({
          id: "second-account",
          name: "Second User",
          email: null,
        });
        await act(async () => result.current.onLoginSuccess("second-token"));
        await act(async () => failVerification?.(new TypeError("Network request failed")));

        expect(result.current.user?.id).toBe("second-account");
        expect(result.current.sessionToken).toBe("second-token");
        expect(result.current.bootstrapError).toBeNull();
        expect(mockSaveSessionUser).toHaveBeenCalledWith("second-token", {
          id: "second-account",
          name: "Second User",
          email: null,
        });
      } finally {
        await act(async () => failVerification?.(new TypeError("Network request failed")));
      }
    });
  });

  describe("logout", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockRemoveMobileQueryCache.mockClear();
    });

    it("clears user state immediately even when server call is slow", async () => {
      const { getSessionToken, fetchCurrentUser, logout: authLogout } = await import("./auth");

      // Simulate a logged-in user
      vi.mocked(getSessionToken).mockResolvedValue("test-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });

      // Make authLogout hang (never resolve) to simulate slow server
      let resolveLogout: (() => void) | undefined;
      vi.mocked(authLogout).mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveLogout = resolve;
          }),
      );

      const { result } = renderHook(() => useAuth(), { wrapper });

      // Wait for initial auth restore to complete
      await waitFor(() => {
        expect(result.current.user).toEqual({
          id: "user-1",
          name: "Test User",
          email: "test@example.com",
        });
      });

      // Call logout — should clear user state immediately
      act(() => {
        void result.current.logout();
      });

      // User should be null immediately, even though authLogout hasn't resolved
      expect(result.current.user).toBeNull();
      expect(result.current.sessionToken).toBeNull();
      expect(mockResetUser).toHaveBeenCalledOnce();

      // Clean up: resolve the pending logout
      if (resolveLogout) resolveLogout();
    });

    it("clears user state even when server call throws", async () => {
      const { getSessionToken, fetchCurrentUser, logout: authLogout } = await import("./auth");

      // Simulate a logged-in user
      vi.mocked(getSessionToken).mockResolvedValue("test-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-1",
        name: "Test User",
        email: null,
      });

      // Make authLogout throw
      vi.mocked(authLogout).mockRejectedValue(new Error("server error"));

      const { result } = renderHook(() => useAuth(), { wrapper });

      // Wait for initial auth restore to complete
      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });

      // Call logout — should clear user state despite the error
      await act(async () => {
        await result.current.logout();
      });

      expect(result.current.user).toBeNull();
      expect(result.current.sessionToken).toBeNull();
      expect(mockResetUser).toHaveBeenCalledOnce();
    });

    it("clears persisted query cache for the active user", async () => {
      const { getSessionToken, fetchCurrentUser, logout: authLogout } = await import("./auth");

      vi.mocked(getSessionToken).mockResolvedValue("test-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });
      vi.mocked(authLogout).mockResolvedValue();

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.user).not.toBeNull();
      });

      await act(async () => {
        await result.current.logout();
      });

      expect(mockRemoveMobileQueryCache).toHaveBeenCalledWith("user-1");
    });

    it("keeps the new account's telemetry identity when an older logout finishes", async () => {
      const { getSessionToken, fetchCurrentUser, logout: authLogout } = await import("./auth");
      vi.mocked(getSessionToken).mockResolvedValue("first-token");
      vi.mocked(fetchCurrentUser).mockResolvedValueOnce({
        id: "first-account",
        name: "First User",
        email: null,
      });
      let resolveLogout: (() => void) | undefined;
      vi.mocked(authLogout).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveLogout = resolve;
          }),
      );
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.user?.id).toBe("first-account"));

      let logout: Promise<void> | undefined;
      act(() => {
        logout = result.current.logout();
      });
      vi.mocked(fetchCurrentUser).mockResolvedValueOnce({
        id: "second-account",
        name: "Second User",
        email: null,
      });
      await act(async () => result.current.onLoginSuccess("second-token"));
      expect(result.current.user?.id).toBe("second-account");
      expect(mockIdentifyUser).toHaveBeenLastCalledWith({
        id: "second-account",
        name: "Second User",
        email: null,
      });
      mockResetUser.mockClear();
      mockIdentifyUser.mockClear();

      await act(async () => {
        if (!resolveLogout || !logout) throw new Error("Logout did not start.");
        resolveLogout();
        await logout;
      });

      expect(result.current.user?.id).toBe("second-account");
      expect(mockResetUser).not.toHaveBeenCalled();
      expect(mockIdentifyUser).not.toHaveBeenCalled();
    });

    it("clears an unused deletion preparation during normal logout", async () => {
      const { getSessionToken, fetchCurrentUser, logout: authLogout } = await import("./auth");
      vi.mocked(getSessionToken).mockResolvedValue("test-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });
      vi.mocked(authLogout).mockResolvedValue();
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.user).not.toBeNull());

      await act(async () => result.current.logout());

      expect(mockClearAccountErasurePreparation).toHaveBeenCalledOnce();
    });
  });

  describe("account erasure", () => {
    it("holds a global cleanup gate and rejects a new login until cleanup finishes", async () => {
      vi.clearAllMocks();
      const {
        getSessionToken,
        fetchCurrentUser,
        logout: authLogout,
        saveSessionToken,
      } = await import("./auth");
      vi.mocked(getSessionToken).mockResolvedValue("test-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.user).not.toBeNull());

      let cleanupLease: ReturnType<typeof result.current.beginAccountErasureCleanup> | undefined;
      act(() => {
        cleanupLease = result.current.beginAccountErasureCleanup("user-1");
      });

      expect(result.current.user).toBeNull();
      expect(result.current.sessionToken).toBeNull();
      expect(result.current.accountErasureCleanupInProgress).toBe(true);
      expect(authLogout).not.toHaveBeenCalled();
      expect(mockResetUser).toHaveBeenCalledOnce();

      await expect(result.current.onLoginSuccess("user-2-token")).rejects.toThrow(
        /account deletion cleanup is still in progress/i,
      );
      expect(saveSessionToken).not.toHaveBeenCalledWith("user-2-token");

      act(() => {
        if (!cleanupLease) throw new Error("Cleanup lease was not created.");
        result.current.finishAccountErasureCleanup(cleanupLease);
      });
      expect(result.current.accountErasureCleanupInProgress).toBe(false);
    });

    it("invalidates an in-flight new-token write before cleanup can purge persistence", async () => {
      vi.clearAllMocks();
      const { fetchCurrentUser, getSessionToken, invalidateSessionPersistence, saveSessionToken } =
        await import("./auth");
      vi.mocked(getSessionToken).mockResolvedValue("user-1-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-1",
        name: "First User",
        email: "first@example.com",
      });
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.user?.id).toBe("user-1"));
      vi.clearAllMocks();

      let resolveWrite: (() => void) | undefined;
      vi.mocked(saveSessionToken).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      );
      let login: Promise<void> | undefined;
      act(() => {
        login = result.current.onLoginSuccess("user-2-token");
      });
      await waitFor(() => expect(saveSessionToken).toHaveBeenCalledWith("user-2-token"));

      let cleanupLease: ReturnType<typeof result.current.beginAccountErasureCleanup> | undefined;
      act(() => {
        cleanupLease = result.current.beginAccountErasureCleanup("user-1");
      });
      expect(invalidateSessionPersistence).toHaveBeenCalledOnce();

      resolveWrite?.();
      if (!login) throw new Error("Login did not start.");
      await expect(login).rejects.toThrow(/account deletion cleanup is still in progress/i);
      expect(result.current.user).toBeNull();
      if (!cleanupLease) throw new Error("Cleanup lease was not created.");
      act(() => result.current.finishAccountErasureCleanup(cleanupLease));
    });

    it("does not re-save a restored token when cleanup starts during the SecureStore read", async () => {
      vi.clearAllMocks();
      const { getSessionToken, invalidateSessionPersistence, saveSessionToken } = await import(
        "./auth"
      );
      vi.mocked(getSessionToken).mockResolvedValueOnce(null);
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.isLoading).toBe(false));
      vi.clearAllMocks();

      let resolveRead: ((token: string) => void) | undefined;
      vi.mocked(getSessionToken).mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveRead = resolve;
          }),
      );
      let retry: Promise<void> | undefined;
      act(() => {
        retry = result.current.retryBootstrap();
      });
      await waitFor(() => expect(getSessionToken).toHaveBeenCalledOnce());

      let cleanupLease: ReturnType<typeof result.current.beginAccountErasureCleanup> | undefined;
      act(() => {
        cleanupLease = result.current.beginAccountErasureCleanup("user-1");
      });
      expect(invalidateSessionPersistence).toHaveBeenCalledOnce();
      resolveRead?.("stale-restored-token");
      if (!retry) throw new Error("Bootstrap retry did not start.");
      await act(async () => retry);

      expect(saveSessionToken).not.toHaveBeenCalled();
      if (!cleanupLease) throw new Error("Cleanup lease was not created.");
      act(() => result.current.finishAccountErasureCleanup(cleanupLease));
    });

    it("does not invalidate a different active account's session persistence", async () => {
      vi.clearAllMocks();
      const { fetchCurrentUser, getSessionToken, invalidateSessionPersistence } = await import(
        "./auth"
      );
      vi.mocked(getSessionToken).mockResolvedValue("user-2-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-2",
        name: "Second User",
        email: "second@example.com",
      });
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.user?.id).toBe("user-2"));
      vi.clearAllMocks();

      let cleanupLease: ReturnType<typeof result.current.beginAccountErasureCleanup> | undefined;
      act(() => {
        cleanupLease = result.current.beginAccountErasureCleanup("user-1");
      });

      expect(invalidateSessionPersistence).not.toHaveBeenCalled();
      expect(result.current.user?.id).toBe("user-2");
      expect(result.current.sessionToken).toBe("user-2-token");
      if (!cleanupLease) throw new Error("Cleanup lease was not created.");
      expect(result.current.isAccountErasureCleanupLeaseCurrent(cleanupLease)).toBe(false);
      act(() => result.current.finishAccountErasureCleanup(cleanupLease));
    });

    it("makes an old cleanup lease stale when a later account becomes active", async () => {
      vi.clearAllMocks();
      const { getSessionToken, fetchCurrentUser } = await import("./auth");
      vi.mocked(getSessionToken).mockResolvedValue("user-1-token");
      vi.mocked(fetchCurrentUser)
        .mockResolvedValueOnce({
          id: "user-1",
          name: "First User",
          email: "first@example.com",
        })
        .mockResolvedValueOnce({
          id: "user-2",
          name: "Second User",
          email: "second@example.com",
        });
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current.user?.id).toBe("user-1"));

      let cleanupLease: ReturnType<typeof result.current.beginAccountErasureCleanup> | undefined;
      act(() => {
        cleanupLease = result.current.beginAccountErasureCleanup("user-1");
      });
      act(() => {
        if (!cleanupLease) throw new Error("Cleanup lease was not created.");
        result.current.finishAccountErasureCleanup(cleanupLease);
      });
      await act(async () => {
        await result.current.onLoginSuccess("user-2-token");
      });

      if (!cleanupLease) throw new Error("Cleanup lease was not created.");
      expect(result.current.user?.id).toBe("user-2");
      expect(result.current.isAccountErasureCleanupLeaseCurrent(cleanupLease)).toBe(false);
    });
  });

  it("restores a signed-in user after a cold offline launch using persisted keychain state", async () => {
    const original = await vi.importActual<typeof import("./auth")>("./auth");
    const auth = await import("./auth");
    original.resetSessionTokenCacheForTests();
    vi.mocked(auth.getSessionToken).mockImplementation(original.getSessionToken);
    vi.mocked(auth.saveSessionToken).mockImplementation(original.saveSessionToken);
    vi.mocked(auth.rotateSessionOwnerNonce).mockImplementation(original.rotateSessionOwnerNonce);
    mockGetSavedSessionUser.mockImplementation(original.getSavedSessionUser);
    mockSaveSessionUser.mockImplementation(original.saveSessionUser);
    const user = { id: "cold-launch-user", name: "Saved User", email: null };
    vi.mocked(auth.fetchCurrentUser).mockResolvedValueOnce(user);
    const initialLaunch = renderHook(() => useAuth(), { wrapper });

    try {
      await waitFor(() => expect(initialLaunch.result.current.isLoading).toBe(false));
      await act(async () => initialLaunch.result.current.onLoginSuccess("persisted-token"));
      const savedOwner = initialLaunch.result.current.accountSessionOwnerNonce;
      initialLaunch.unmount();
      // A new process has no token or React state in memory; only keychain survives.
      original.resetSessionTokenCacheForTests();
      const offlineError = new TypeError("Network request failed");
      vi.mocked(auth.fetchCurrentUser).mockRejectedValueOnce(offlineError);
      const offlineLaunch = renderHook(() => useAuth(), { wrapper });

      try {
        await waitFor(() => expect(offlineLaunch.result.current.isLoading).toBe(false));
        expect(offlineLaunch.result.current.user).toEqual(user);
        expect(offlineLaunch.result.current.sessionToken).toBe("persisted-token");
        expect(offlineLaunch.result.current.accountSessionOwnerNonce).toBe(savedOwner);
        expect(offlineLaunch.result.current.bootstrapError).toBeNull();
      } finally {
        offlineLaunch.unmount();
      }
    } finally {
      initialLaunch.unmount();
      original.resetSessionTokenCacheForTests();
      vi.mocked(auth.getSessionToken).mockReset().mockResolvedValue(null);
      vi.mocked(auth.saveSessionToken).mockReset().mockResolvedValue();
      vi.mocked(auth.rotateSessionOwnerNonce)
        .mockReset()
        .mockResolvedValue("11111111-1111-4111-8111-111111111111");
      mockGetSavedSessionUser.mockReset().mockResolvedValue(null);
      mockSaveSessionUser.mockReset().mockResolvedValue();
    }
  });
});
