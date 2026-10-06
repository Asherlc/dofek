// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimeRangePreference } from "./useTimeRangePreference.ts";

const { mockCaptureException } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: mockCaptureException,
}));

const storedValues = new Map<string, string>();
const mockStorage: Storage = {
  get length() {
    return storedValues.size;
  },
  clear: () => storedValues.clear(),
  getItem: (key) => storedValues.get(key) ?? null,
  key: (index) => [...storedValues.keys()][index] ?? null,
  removeItem: (key) => storedValues.delete(key),
  setItem: (key, value) => storedValues.set(key, value),
};

describe("useTimeRangePreference", () => {
  beforeEach(() => {
    mockStorage.clear();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: mockStorage,
    });
    mockCaptureException.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the canonical domain default and explanation", () => {
    const { result } = renderHook(() => useTimeRangePreference("nutrition"));

    expect(result.current.days).toBe(90);
    expect(result.current.description).toBe(
      "Recommended default: 90 days provides enough intake and weight history for stable trends.",
    );
  });

  it("restores and persists one selection across related screens", () => {
    window.localStorage.setItem("dofek.time-range.training", "30");
    const trainingScreen = renderHook(() => useTimeRangePreference("training"));

    expect(trainingScreen.result.current.days).toBe(30);
    act(() => trainingScreen.result.current.setDays(365));
    trainingScreen.unmount();

    const relatedTrainingScreen = renderHook(() => useTimeRangePreference("training"));
    expect(relatedTrainingScreen.result.current.days).toBe(365);
    expect(window.localStorage.getItem("dofek.time-range.training")).toBe("365");
  });

  it("reports unexpected storage read and write failures", () => {
    const readError = new Error("storage read failed");
    vi.spyOn(mockStorage, "getItem").mockImplementationOnce(() => {
      throw readError;
    });

    const { result } = renderHook(() => useTimeRangePreference("body"));
    expect(result.current.days).toBe(30);
    expect(mockCaptureException).toHaveBeenCalledWith(readError, {
      source: "time-range-preference-read",
      domain: "body",
    });

    const writeError = new Error("storage write failed");
    vi.spyOn(mockStorage, "setItem").mockImplementationOnce(() => {
      throw writeError;
    });
    act(() => result.current.setDays(90));
    expect(mockCaptureException).toHaveBeenCalledWith(writeError, {
      source: "time-range-preference-write",
      domain: "body",
    });
  });
});
