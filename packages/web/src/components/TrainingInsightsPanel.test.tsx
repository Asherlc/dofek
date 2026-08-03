/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  expectRegistryInputs,
  resetRangePlumbingState,
  state,
} from "../routes/training/range-plumbing.test-helper.tsx";
import { TrainingInsightsPanel } from "./TrainingInsightsPanel.tsx";

describe("TrainingInsightsPanel range plumbing", () => {
  beforeEach(resetRangePlumbingState);
  afterEach(cleanup);

  it("passes finite and All ranges to selected-range chart queries", () => {
    render(<TrainingInsightsPanel days={30} />);
    expectRegistryInputs("trainingInsightsPanel", 30);

    cleanup();
    state.queryCalls.length = 0;
    render(<TrainingInsightsPanel days={null} />);
    expectRegistryInputs("trainingInsightsPanel", null);
  });

  it("leads with a plain description and keeps the server explanation accessible", () => {
    state.trainingHrZonesQuery = {
      data: {
        maxHr: 190,
        weeks: [
          {
            max_hr: 190,
            week: "2026-07-20",
            zone0: 0,
            zone1: 600,
            zone2: 1200,
            zone3: 300,
            zone4: 200,
            zone5: 100,
          },
        ],
        intensityDistribution: {
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 2400,
          zones: [
            { zone: 1, label: "Recovery", seconds: 600, percent: 25 },
            { zone: 2, label: "Aerobic", seconds: 1200, percent: 50 },
          ],
          explanation: "Server says this is descriptive and is not a polarization classification.",
        },
      },
      isLoading: false,
      error: null,
    };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.getByText("Heart-rate zone distribution")).toBeDefined();
    expect(
      screen.getByText("Shows how recorded heart-rate time is distributed across effort zones."),
    ).toBeDefined();
    expect(
      screen.queryByText(
        "Server says this is descriptive and is not a polarization classification.",
      ),
    ).toBeNull();

    expect(screen.getByRole("button", { name: "About this chart" })).toHaveAttribute(
      "data-description",
      expect.stringContaining(
        "Server says this is descriptive and is not a polarization classification.",
      ),
    );
  });

  it("renders query failures separately from an empty period", () => {
    state.trainingVolumeQuery = {
      data: undefined,
      isLoading: false,
      error: new Error("Weekly volume query failed"),
    };
    state.trainingHrZonesQuery = {
      data: undefined,
      isLoading: false,
      error: new Error("Heart-rate zones query failed"),
    };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.getByText("Weekly volume query failed")).toBeDefined();
    expect(screen.getByText("Heart-rate zones query failed")).toBeDefined();
    expect(screen.queryByText("No training data in this period")).toBeNull();
  });

  it("keeps cached training data visible with background query failures", () => {
    state.trainingVolumeQuery = {
      data: [{ week: "2026-07-20", canonical_type: "cycling", count: 1, hours: 2 }],
      isLoading: false,
      error: new Error("Weekly volume refresh failed"),
    };
    state.trainingHrZonesQuery = {
      data: {
        maxHr: 190,
        weeks: [
          {
            max_hr: 190,
            week: "2026-07-20",
            zone0: 0,
            zone1: 600,
            zone2: 1200,
            zone3: 300,
            zone4: 200,
            zone5: 100,
          },
        ],
        intensityDistribution: {
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 2400,
          zones: [{ zone: 2, label: "Aerobic", seconds: 1200, percent: 50 }],
          explanation: "Cached intensity distribution.",
        },
      },
      isLoading: false,
      error: new Error("Heart-rate zones refresh failed"),
    };

    render(<TrainingInsightsPanel days={30} />);

    expect(screen.getByText("Weekly volume refresh failed")).toBeDefined();
    expect(screen.getByText("Heart-rate zones refresh failed")).toBeDefined();
    expect(screen.getByText("Weekly Training Volume")).toBeDefined();
    expect(
      screen.getByText("Shows how recorded heart-rate time is distributed across effort zones."),
    ).toBeDefined();
  });
});
