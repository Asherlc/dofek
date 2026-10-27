// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const appStateListeners: Array<(state: string) => void> = [];
  return {
    appStateListeners,
    refetch: vi.fn(),
    remove: vi.fn(),
    useQuery: vi.fn(),
  };
});

vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      mocks.appStateListeners.push(listener);
      return { remove: mocks.remove };
    }),
  },
}));

vi.mock("./trpc", () => ({
  trpc: {
    processing: {
      status: {
        useQuery: (...arguments_: unknown[]) => mocks.useQuery(...arguments_),
      },
    },
  },
}));

import { useProcessingStatus } from "./useProcessingStatus";

describe("useProcessingStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.appStateListeners.length = 0;
    mocks.useQuery.mockReturnValue({ refetch: mocks.refetch });
    mocks.refetch.mockResolvedValue({ data: undefined });
  });

  it("refetches immediately when the app returns to the foreground", async () => {
    renderHook(() => useProcessingStatus({ datasets: ["activity"] }));
    const appStateListener = mocks.appStateListeners.at(0);
    if (!appStateListener) throw new Error("Expected an AppState listener");

    act(() => appStateListener("background"));
    await act(async () => appStateListener("active"));

    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
