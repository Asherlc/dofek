import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mockSelection = vi.fn(() => Promise.resolve());
const mockImpact = vi.fn(() => Promise.resolve());
const mockNotification = vi.fn(() => Promise.resolve());

vi.mock("expo-haptics", () => ({
  selectionAsync: () => mockSelection(),
  impactAsync: (style: string) => mockImpact(style),
  notificationAsync: (type: string) => mockNotification(type),
  ImpactFeedbackStyle: { Light: "light", Medium: "medium", Heavy: "heavy" },
  NotificationFeedbackType: { Success: "success", Warning: "warning", Error: "error" },
}));

describe("useHaptic", () => {
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
});
