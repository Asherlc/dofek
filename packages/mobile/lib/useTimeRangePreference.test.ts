import AsyncStorage from "@react-native-async-storage/async-storage";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTimeRangePreference } from "./useTimeRangePreference";

const { mockCaptureException } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
}));

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

describe("useTimeRangePreference", () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    mockCaptureException.mockClear();
    vi.mocked(AsyncStorage.getItem).mockClear();
    vi.mocked(AsyncStorage.setItem).mockClear();
  });

  it("uses the canonical domain default and explanation", () => {
    const { result } = renderHook(() => useTimeRangePreference("training"));

    expect(result.current.days).toBe(90);
    expect(result.current.isHydrated).toBe(false);
    expect(result.current.description).toBe(
      "Recommended default: 90 days balances recent training changes with enough history.",
    );
  });

  it("exposes the restored range only after storage hydration settles", async () => {
    let resolveStorage: ((value: string | null) => void) | undefined;
    vi.mocked(AsyncStorage.getItem).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStorage = resolve;
        }),
    );
    const { result } = renderHook(() => useTimeRangePreference("training"));

    expect(result.current).toMatchObject({ days: 90, isHydrated: false });

    act(() => resolveStorage?.("30"));

    await waitFor(() => expect(result.current).toMatchObject({ days: 30, isHydrated: true }));
  });

  it("restores and persists one selection across related screens", async () => {
    await AsyncStorage.setItem("dofek.time-range.training", "30");
    const trainingScreen = renderHook(() => useTimeRangePreference("training"));

    await waitFor(() => expect(trainingScreen.result.current.days).toBe(30));
    act(() => trainingScreen.result.current.setDays(90));
    await waitFor(() =>
      expect(AsyncStorage.getItem("dofek.time-range.training")).resolves.toBe("90"),
    );
    trainingScreen.unmount();

    const strainScreen = renderHook(() => useTimeRangePreference("training"));
    await waitFor(() => expect(strainScreen.result.current.days).toBe(90));
  });

  it("treats the unsupported mobile all value as corrupt finite-range state", async () => {
    await AsyncStorage.setItem("dofek.time-range.training", "all");
    const { result } = renderHook(() => useTimeRangePreference("training"));

    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.days).toBe(90);
  });

  it("reports unexpected storage read and write failures", async () => {
    const readError = new Error("storage read failed");
    vi.mocked(AsyncStorage.getItem).mockRejectedValueOnce(readError);
    const { result } = renderHook(() => useTimeRangePreference("sleep"));

    await waitFor(() =>
      expect(mockCaptureException).toHaveBeenCalledWith(readError, {
        source: "time-range-preference-read",
        domain: "sleep",
      }),
    );
    await waitFor(() => expect(result.current.isHydrated).toBe(true));
    expect(result.current.days).toBe(30);

    const writeError = new Error("storage write failed");
    vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(writeError);
    act(() => result.current.setDays(90));
    await waitFor(() =>
      expect(mockCaptureException).toHaveBeenCalledWith(writeError, {
        source: "time-range-preference-write",
        domain: "sleep",
      }),
    );
  });
});
