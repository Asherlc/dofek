import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCaptureException } = vi.hoisted(() => ({
  mockCaptureException: vi.fn(),
}));

const mockSelection = vi.fn<() => Promise<void>>(() => Promise.resolve());
const mockImpact = vi.fn(() => Promise.resolve());
const mockNotification = vi.fn(() => Promise.resolve());

vi.mock("expo-haptics", () => ({
  selectionAsync: () => mockSelection(),
  impactAsync: (style: string) => mockImpact(style),
  notificationAsync: (type: string) => mockNotification(type),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

describe("useHaptic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelection.mockResolvedValue(undefined);
  });

  it("exports selection, impact, and notification functions", async () => {
    const { useHaptic } = await import("./useHaptic");
    const { result } = renderHook(() => useHaptic());

    expect(typeof result.current.selection).toBe("function");
    expect(typeof result.current.impact).toBe("function");
    expect(typeof result.current.notification).toBe("function");
  });

  it("calls selectionAsync on selection()", async () => {
    const { useHaptic } = await import("./useHaptic");
    const { result } = renderHook(() => useHaptic());

    result.current.selection();
    expect(mockSelection).toHaveBeenCalled();
  });

  it("models unavailable optional haptics without reporting an operational defect", async () => {
    const unavailableError = Object.assign(new Error("Haptics unavailable"), {
      code: "ERR_UNAVAILABLE",
    });
    mockSelection.mockRejectedValue(unavailableError);
    const { useHaptic } = await import("./useHaptic");
    const { result } = renderHook(() => useHaptic());

    result.current.selection();

    await vi.waitFor(() => {
      expect(mockSelection).toHaveBeenCalled();
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("reports unexpected haptic failures", async () => {
    const hapticError = new Error("Native bridge failed");
    mockSelection.mockRejectedValue(hapticError);
    const { useHaptic } = await import("./useHaptic");
    const { result } = renderHook(() => useHaptic());

    result.current.selection();

    await vi.waitFor(() => {
      expect(mockCaptureException).toHaveBeenCalledWith(hapticError, {
        source: "optional-haptic-feedback",
      });
    });
  });
});
