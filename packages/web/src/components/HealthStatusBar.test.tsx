// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HealthStatusBar } from "./HealthStatusBar.tsx";

describe("HealthStatusBar", () => {
  it("renders structured formatted value units with normal weight", () => {
    const { container } = render(
      <HealthStatusBar
        metrics={[
          {
            label: "Skin Temp",
            value: 34.4,
            avg: 34,
            stddev: 0.5,
            formatValue: () => ({
              text: "94.0°F",
              parts: [
                { type: "integer", value: "94" },
                { type: "decimal", value: "." },
                { type: "fraction", value: "0" },
                { type: "unit", value: "°F" },
              ],
            }),
          },
        ]}
      />,
    );

    const value = screen.getByText("94.0");
    const unit = screen.getByText("°F");

    expect(value.className).not.toContain("font-normal");
    expect(unit.className).toContain("font-normal");
    expect(container.querySelector(".font-semibold")?.textContent).toContain("94.0°F");
  });

  it("uses unique keys when formatted measurement segment text repeats", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <HealthStatusBar
        metrics={[
          {
            label: "Repeated",
            value: 1,
            avg: null,
            stddev: null,
            formatValue: () => ({
              text: "1kg1kg",
              parts: [
                { type: "integer", value: "1" },
                { type: "unit", value: "kg" },
                { type: "integer", value: "1" },
                { type: "unit", value: "kg" },
              ],
            }),
          },
        ]}
      />,
    );

    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("Encountered two children with the same key"),
    );
    consoleError.mockRestore();
  });

  describe("directional status coloring", () => {
    it("shows green for HRV elevated above average (higher is better)", () => {
      // HRV: avg=50, stddev=10, value=65 → z=+1.5 above average → good
      const { container } = render(
        <HealthStatusBar
          metrics={[
            {
              label: "Heart Rate Variability",
              value: 65,
              avg: 50,
              stddev: 10,
              unit: "ms",
              lowerBetter: false,
            },
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
            {
              label: "Heart Rate Variability",
              value: 35,
              avg: 50,
              stddev: 10,
              unit: "ms",
              lowerBetter: false,
            },
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
        <HealthStatusBar metrics={[{ label: "Steps", value: 13000, avg: 8000, stddev: 2000 }]} />,
      );
      expect(screen.getByText(/Abnormal/)).toBeDefined();
    });
  });
});
