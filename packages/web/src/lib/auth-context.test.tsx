// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./auth-context.tsx";

const mockCaptureException = vi.hoisted(() => vi.fn());
const mockIdentifyPostHogUser = vi.hoisted(() => vi.fn());
const mockResetPostHogUser = vi.hoisted(() => vi.fn());

vi.mock("./telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

vi.mock("./posthog.ts", () => ({
  identifyPostHogUser: mockIdentifyPostHogUser,
  resetPostHogUser: mockResetPostHogUser,
}));

vi.mock("./auth.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth.ts")>();
  return {
    ...original,
    fetchCurrentUser: vi.fn(() => Promise.resolve(null)),
    logout: vi.fn(() => Promise.resolve()),
  };
});

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

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

    expect(mockIdentifyPostHogUser).toHaveBeenCalledOnce();
    expect(mockIdentifyPostHogUser).toHaveBeenCalledWith(user);
    expect(mockResetPostHogUser).not.toHaveBeenCalled();
  });

  it("does not identify or reset an unauthenticated visitor during bootstrap", async () => {
    const { fetchCurrentUser } = await import("./auth.ts");
    vi.mocked(fetchCurrentUser).mockResolvedValue(null);

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockIdentifyPostHogUser).not.toHaveBeenCalled();
    expect(mockResetPostHogUser).not.toHaveBeenCalled();
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

    expect(mockResetPostHogUser).toHaveBeenCalledOnce();
    expect(vi.mocked(logout).mock.invocationCallOrder[0]).toBeLessThan(
      mockResetPostHogUser.mock.invocationCallOrder[0] ?? 0,
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

    expect(mockResetPostHogUser).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledWith(error, { source: "logout" });
  });
});
