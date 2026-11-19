// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunningFormStats } from "./RunningFormStats";

describe("RunningFormStats", () => {
  it("renders available readings with their cadence basis and omits absent ones", () => {
    render(
      <RunningFormStats
        form={{
          cadence: 178,
          cadenceBasis: "cadence_samples",
          cadenceObservedSeconds: 600,
          cadenceCoveragePercent: null,
          strideLengthMeters: 1.24,
          stanceTimeMs: null,
          verticalOscillationMm: 8,
        }}
      />,
    );
    const readings = screen.getByLabelText("Running Form readings");
    expect(readings.textContent).toContain("178 spm");
    expect(readings.textContent).toContain("Recorded cadence");
    expect(readings.textContent).toContain("1.24 m");
    expect(readings.textContent).toContain("8.0 mm");
    expect(readings.textContent).not.toContain("Ground contact time");
  });

  it("keeps a recorded zero cadence and step-interval coverage", () => {
    render(
      <RunningFormStats
        form={{
          cadence: 0,
          cadenceBasis: "step_intervals",
          cadenceObservedSeconds: 120,
          cadenceCoveragePercent: 30,
          strideLengthMeters: null,
          stanceTimeMs: null,
          verticalOscillationMm: null,
        }}
      />,
    );
    const readings = screen.getByLabelText("Running Form readings");
    expect(readings.textContent).toContain("0 spm");
    expect(readings.textContent).toContain("Steps · 30% coverage");
  });
});
