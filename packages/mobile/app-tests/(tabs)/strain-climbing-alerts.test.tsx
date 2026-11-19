// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { AccessibilityInfo } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockAttemptIncreaseInvalidate,
  mockAttemptIncreaseQuery,
  mockQueryState,
  mockStrengthsState,
  mockVolumeIncreaseInvalidate,
  mockVolumeIncreaseQuery,
  resetStrainMocks,
} from "./strain-test-helpers";

describe("Training climbing alerts", () => {
  beforeEach(resetStrainMocks);

  it("shows the fixed-window climbing volume increase and clears it after refresh", async () => {
    mockVolumeIncreaseQuery.mockReturnValue({
      data: {
        status: "increase",
        recentMinutes: 300,
        baselineMinutes: 210,
        increasePercent: 42.86,
      },
      error: null,
    });
    const { default: StrainScreen } = await import("../../app/strain");
    const { rerender } = render(<StrainScreen />);
    expect(screen.getByText("Climbing volume increased")).toBeTruthy();
    expect(
      screen.getByText(
        "You logged 5 hours of climbing in the last 7 days, up 43% from your recent weekly average of 3 hours 30 minutes.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Filters ⌄" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "All climbing" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Lead" }));
    expect(mockVolumeIncreaseQuery).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ enabled: true }),
    );
    expect(screen.getByText("Climbing volume increased")).toBeTruthy();

    await mockQueryState.refreshInvalidate?.();
    expect(mockVolumeIncreaseInvalidate).toHaveBeenCalledOnce();
    mockVolumeIncreaseQuery.mockReturnValue({ data: { status: "below_threshold" }, error: null });
    rerender(<StrainScreen />);
    expect(screen.queryByText("Climbing volume increased")).toBeNull();
  });

  it("shows an attempt increase independently and refreshes its comparison", async () => {
    mockAttemptIncreaseQuery.mockReturnValue({
      data: { status: "increase", recentAttempts: 50, baselineAttempts: 40, increasePercent: 25 },
      error: null,
    });
    const { default: StrainScreen } = await import("../../app/strain");
    render(<StrainScreen />);
    expect(screen.getByText("Recorded climbing attempts increased")).toBeTruthy();
    expect(screen.getByText(/50 climbing attempts in the last 7 days, up 25%/)).toBeTruthy();
    expect(screen.queryByText("Climbing volume increased")).toBeNull();
    await mockQueryState.refreshInvalidate?.();
    expect(mockAttemptIncreaseInvalidate).toHaveBeenCalledOnce();
  });

  it("reloads stale comparisons when Training regains focus", async () => {
    const { default: StrainScreen } = await import("../../app/strain");
    const { rerender } = render(<StrainScreen />);
    mockQueryState.focused = false;
    rerender(<StrainScreen />);
    expect(mockVolumeIncreaseQuery.mock.lastCall?.[1]).toMatchObject({ enabled: false });
    expect(mockAttemptIncreaseQuery.mock.lastCall?.[1]).toMatchObject({ enabled: false });

    mockQueryState.focused = true;
    rerender(<StrainScreen />);
    expect(mockVolumeIncreaseQuery.mock.lastCall?.[1]).toMatchObject({
      enabled: true,
      staleTime: 0,
      refetchOnWindowFocus: true,
    });
    expect(mockAttemptIncreaseQuery.mock.lastCall?.[1]).toMatchObject({
      enabled: true,
      staleTime: 0,
      refetchOnWindowFocus: true,
    });
  });

  it("suppresses the cached refresh announcement while Training is offscreen", async () => {
    const announce = vi.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
    announce.mockClear();
    mockStrengthsState.isFetching = true;
    mockQueryState.focused = false;
    const { default: StrainScreen } = await import("../../app/strain");
    const { rerender } = render(<StrainScreen />);
    expect(screen.getByText("Climbing strengths")).toBeTruthy();
    expect(announce).not.toHaveBeenCalled();

    mockQueryState.focused = true;
    rerender(<StrainScreen />);
    expect(announce).toHaveBeenCalledExactlyOnceWith("Updating climbing strengths…", {
      queue: true,
    });
  });

  it("keeps the comparison while refreshing and hides it after a failed refresh", async () => {
    const data = {
      status: "increase",
      recentMinutes: 300,
      baselineMinutes: 210,
      increasePercent: 42.86,
    };
    mockVolumeIncreaseQuery.mockReturnValue({ data, isFetching: true, error: null });
    const { default: StrainScreen } = await import("../../app/strain");
    const { rerender } = render(<StrainScreen />);
    expect(screen.getByText("Climbing volume increased")).toBeTruthy();

    mockVolumeIncreaseQuery.mockReturnValue({
      data,
      error: new Error("Climbing time unavailable"),
    });
    rerender(<StrainScreen />);
    expect(screen.getByText("Climbing time unavailable")).toBeTruthy();
    expect(screen.getByText("Climbing locations")).toBeTruthy();
    expect(screen.queryByText("Climbing volume increased")).toBeNull();
  });
});
