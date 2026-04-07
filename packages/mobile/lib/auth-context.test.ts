import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth-context";

// expo-secure-store, expo-web-browser, expo-apple-authentication, and react-native
// are mocked globally in test-setup.ts

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

  describe("logout", () => {
    beforeEach(() => {
      vi.clearAllMocks();
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
  });
});
