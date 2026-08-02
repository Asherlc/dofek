import { describe, expect, it, vi } from "vitest";
import {
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
  });
});
