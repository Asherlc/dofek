import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { AppState } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth-context";

const mockRemoveMobileQueryCache = vi.hoisted(() => vi.fn(() => Promise.resolve()));

// expo-secure-store, expo-web-browser, expo-apple-authentication, and react-native
// are mocked globally in test-setup.ts

vi.mock("./mobile-query-persistence", () => ({
  removeMobileQueryCache: mockRemoveMobileQueryCache,
}));

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

vi.mock("./auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth")>();
  return {
    ...original,
    logout: vi.fn(() => Promise.resolve()),
    clearSessionToken: vi.fn(() => Promise.resolve()),
    getSessionToken: vi.fn(() => Promise.resolve(null)),
    saveSessionToken: vi.fn(() => Promise.resolve()),
    fetchCurrentUser: vi.fn(() => Promise.resolve(null)),
  };
});

function wrapper({ children }: { children: ReactNode }) {
  return createElement(AuthProvider, null, children);
}

describe("auth-context", () => {
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
    });

    it("does not re-save when no token exists", async () => {
      const { getSessionToken, saveSessionToken } = await import("./auth");

      vi.mocked(getSessionToken).mockResolvedValue(null);

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(saveSessionToken).not.toHaveBeenCalled();
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
        expect(result.current.isLoading).toBe(true);
      });

      expect(saveSessionToken).not.toHaveBeenCalled();
      expect(result.current.user).toBeNull();
      expect(mockCaptureException).not.toHaveBeenCalled();

      AppState.currentState = "active";
      vi.mocked(getSessionToken).mockResolvedValue("existing-token");
      vi.mocked(fetchCurrentUser).mockResolvedValue({
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
      });

      await act(async () => {
        const latestListener = appStateListeners.at(-1);
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
  });
});
