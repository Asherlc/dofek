import { describe, expect, it, vi } from "vitest";
import type { ActivityOverviewComparison } from "./activity-overview.ts";
import {
  activityOverviewChangeForLabel,
  formatActivityOverviewChange,
  formatActivityOverviewDistance,
  formatActivityOverviewElevation,
} from "./activity-overview.ts";

describe("activity overview availability formatting", () => {
  it("uses shared copy when a measurement was not recorded", () => {
    const formatMeasured = vi.fn((value: number) => `${value}`);

    expect(formatActivityOverviewDistance(null, formatMeasured)).toBe("Distance not recorded");
    expect(formatActivityOverviewElevation(null, formatMeasured)).toBe("Elevation unavailable");
    expect(formatMeasured).not.toHaveBeenCalled();
  });

  it("formats measured zero values normally", () => {
    const formatMeasured = vi.fn((value: number) => `${value} measured`);

    expect(formatActivityOverviewDistance(0, formatMeasured)).toBe("0 measured");
    expect(formatActivityOverviewElevation(0, formatMeasured)).toBe("0 measured");
    expect(formatMeasured).toHaveBeenCalledTimes(2);
  });

  it("formats server-authored period changes without deriving direction", () => {
    const formatMagnitude = vi.fn((value: number) => `${value} units`);

    expect(
      formatActivityOverviewChange(
        { magnitude: 2, trend: "higher" },
        "previous 4 weeks",
        formatMagnitude,
      ),
    ).toBe("2 units more vs previous 4 weeks");
    expect(
      formatActivityOverviewChange(
        { magnitude: 3, trend: "lower" },
        "previous 4 weeks",
        formatMagnitude,
      ),
    ).toBe("3 units less vs previous 4 weeks");
    expect(
      formatActivityOverviewChange(
        { magnitude: 0, trend: "unchanged" },
        "previous 4 weeks",
        formatMagnitude,
      ),
    ).toBe("No change vs previous 4 weeks");
    expect(formatMagnitude).toHaveBeenCalledWith(2);
    expect(formatMagnitude).toHaveBeenCalledWith(3);
  });

  it("treats an unavailable trend or magnitude as unavailable independently", () => {
    const formatMagnitude = vi.fn((value: number | null) => `${value} units`);

    expect(
      formatActivityOverviewChange(
        { magnitude: 2, trend: "unavailable" },
        "previous 4 weeks",
        formatMagnitude,
      ),
    ).toBe("Comparison unavailable vs previous 4 weeks");
    expect(
      formatActivityOverviewChange(
        { magnitude: null, trend: "higher" },
        "previous 4 weeks",
        formatMagnitude,
      ),
    ).toBe("Comparison unavailable vs previous 4 weeks");
    expect(formatMagnitude).not.toHaveBeenCalled();
  });

  it("explains when a comparison measurement is unavailable", () => {
    expect(
      formatActivityOverviewChange(
        {
          magnitude: null,
          trend: "unavailable",
          state: { status: "missing", reason: "Previous period: Distance not recorded" },
        },
        "previous 4 weeks",
        (value) => `${value}`,
      ),
    ).toBe("Comparison unavailable: Previous period: Distance not recorded");

    expect(
      formatActivityOverviewChange(
        {
          magnitude: null,
          trend: "unavailable",
          state: { status: "available" },
        },
        "previous 4 weeks",
        (value) => `${value}`,
      ),
    ).toBe("Comparison unavailable vs previous 4 weeks");
  });

  it("maps each overview label to its server-authored comparison", () => {
    const comparison: ActivityOverviewComparison = {
      periodLabel: "previous 4 weeks",
      activityCount: { magnitude: 1, trend: "higher" },
      totalMinutes: { magnitude: 2, trend: "lower" },
      totalDistanceMeters: {
        magnitude: 3,
        trend: "unchanged",
        state: { status: "available" },
      },
      totalElevationGainM: {
        magnitude: null,
        trend: "unavailable",
        state: { status: "missing", reason: "No elevation" },
      },
    };

    expect(activityOverviewChangeForLabel(comparison, "Activities")).toBe(comparison.activityCount);
    expect(activityOverviewChangeForLabel(comparison, "Time")).toBe(comparison.totalMinutes);
    expect(activityOverviewChangeForLabel(comparison, "Distance")).toBe(
      comparison.totalDistanceMeters,
    );
    expect(activityOverviewChangeForLabel(comparison, "Elevation")).toBe(
      comparison.totalElevationGainM,
    );
    expect(activityOverviewChangeForLabel(comparison, "Unknown")).toBeUndefined();
  });
});
