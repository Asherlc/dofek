import { describe, expect, it, vi } from "vitest";
import {
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
});
