import { describe, expect, it } from "vitest";
import {
  cyclingDurabilityDurations,
  cyclingDurabilityWorkLevels,
  formatDurabilityOffset,
  formatDurabilityPower,
  formatDurabilityRange,
  formatDurabilityWeight,
  formatDurabilityWork,
} from "./cycling-durability.ts";

describe("cycling durability presentation", () => {
  it("provides the approved effort lengths and minimum work options", () => {
    expect(cyclingDurabilityDurations).toEqual([
      { value: 10, label: "10 seconds", adjective: "10-second" },
      { value: 60, label: "1 minute", adjective: "1-minute" },
      { value: 300, label: "5 minutes", adjective: "5-minute" },
      { value: 1200, label: "20 minutes", adjective: "20-minute" },
    ]);
    expect(cyclingDurabilityWorkLevels).toEqual([10, 20, 30, 40, 50]);
  });

  it("uses the selection unit and the available calendar range", () => {
    expect(formatDurabilityPower(295.7, "watts")).toBe("296 W");
    expect(formatDurabilityPower(4.4444, "w_per_kg")).toBe("4.44 W/kg");
    expect(formatDurabilityWork(2159.8)).toBe("2,160 kJ");
    expect(formatDurabilityWork(30, true)).toBe("30 kJ/kg");
    expect(formatDurabilityRange("2026-10-19", "2026-11-15")).toBe("Oct 19, 2026 – Nov 15, 2026");
    expect(formatDurabilityRange(null, "2026-11-15")).toBe("All dates");
  });

  it("formats elapsed time within an hour and across hours", () => {
    expect(formatDurabilityOffset(59.9)).toBe("00:59");
    expect(formatDurabilityOffset(1122)).toBe("18:42");
    expect(formatDurabilityOffset(3600)).toBe("1:00:00");
    expect(formatDurabilityOffset(12136)).toBe("3:22:16");
  });

  it("preserves the formatted body weight and labels its matching method", () => {
    expect(formatDurabilityWeight("measured", "158.7 lb")).toBe("Measured weight · 158.7 lb");
    expect(formatDurabilityWeight("interpolated", "75.0 kg")).toBe(
      "Estimated weight from two readings · 75.0 kg",
    );
    expect(formatDurabilityWeight("nearest", "72.0 kg")).toBe(
      "Estimated weight from the nearest reading · 72.0 kg",
    );
  });
});
