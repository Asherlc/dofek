// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthStatusBar } from "./HealthStatusBar.tsx";

describe("HealthStatusBar", () => {
  describe("directional status coloring", () => {
    it("shows green for HRV elevated above average (higher is better)", () => {
      // HRV: avg=50, stddev=10, value=65 → z=+1.5 above average → good
      const { container } = render(
        <HealthStatusBar
          metrics={[
            { label: "HRV", value: 65, avg: 50, stddev: 10, unit: "ms", lowerBetter: false },
          ]}
        />,
      );
      // The status dot should be green (emerald), not yellow/amber
      const dot = container.querySelector("[class*='bg-emerald']");
      expect(dot).not.toBeNull();
      // Should show "Normal" or a positive label, not "Elevated"
      expect(screen.getByText(/Normal/)).toBeDefined();
    });

    it("shows yellow for HRV below average (higher is better, value dropping)", () => {
      // HRV: avg=50, stddev=10, value=35 → z=-1.5 below average → concerning
      render(
        <HealthStatusBar
          metrics={[
            { label: "HRV", value: 35, avg: 50, stddev: 10, unit: "ms", lowerBetter: false },
          ]}
        />,
      );
      expect(screen.getByText(/Elevated/)).toBeDefined();
    });

    it("shows green for resting HR below average (lower is better)", () => {
      // RHR: avg=60, stddev=5, value=50 → z=-2 below average → good for lowerBetter
      const { container } = render(
        <HealthStatusBar
          metrics={[
            { label: "RHR", value: 50, avg: 60, stddev: 5, unit: "bpm", lowerBetter: true },
          ]}
        />,
      );
      const dot = container.querySelector("[class*='bg-emerald']");
      expect(dot).not.toBeNull();
      expect(screen.getByText(/Normal/)).toBeDefined();
    });

    it("shows yellow for resting HR above average (lower is better, value rising)", () => {
      // RHR: avg=60, stddev=5, value=68 → z=+1.6 above average → bad for lowerBetter
      render(
        <HealthStatusBar
          metrics={[
            { label: "RHR", value: 68, avg: 60, stddev: 5, unit: "bpm", lowerBetter: true },
          ]}
        />,
      );
      expect(screen.getByText(/Elevated/)).toBeDefined();
    });

    it("uses absolute z-score when lowerBetter is undefined (no direction preference)", () => {
      // Steps: avg=8000, stddev=2000, value=13000 → z=+2.5 → any deviation is flagged
      render(
        <HealthStatusBar
          metrics={[{ label: "Steps", value: 13000, avg: 8000, stddev: 2000, unit: "" }]}
        />,
      );
      expect(screen.getByText(/Abnormal/)).toBeDefined();
    });
  });
});
