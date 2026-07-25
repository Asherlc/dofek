// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrainingDistributionCards } from "./TrainingDistributionCards";

describe("TrainingDistributionCards", () => {
  it("renders server-computed Karvonen percentages without classifying them", () => {
    render(
      <TrainingDistributionCards
        intensityDistribution={{
          model: "karvonen-five-zone",
          activityScope: "endurance",
          totalSeconds: 3600,
          zones: [
            { zone: 1, label: "Recovery", seconds: 900, percent: 25 },
            { zone: 2, label: "Aerobic", seconds: 2700, percent: 75 },
          ],
          explanation: "Server-provided descriptive Karvonen explanation.",
        }}
        polarization={null}
      />,
    );

    expect(screen.getByText("Karvonen Intensity Distribution")).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText("Aerobic")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    expect(screen.getByText("Server-provided descriptive Karvonen explanation.")).toBeTruthy();
  });

  it("renders the exact Treff status and explanation returned by the server", () => {
    render(
      <TrainingDistributionCards
        intensityDistribution={null}
        polarization={{
          model: "treff-three-zone",
          activityScope: "cycling",
          threshold: 2,
          maxHr: 190,
          explanation: "Server-provided Treff explanation.",
          weeks: [
            {
              week: "2026-07-20",
              z1Seconds: 4800,
              z2Seconds: 600,
              z3Seconds: 600,
              polarizationIndex: 2,
              totalSeconds: 6000,
              zonePercentages: { z1: 80, z2: 10, z3: 10 },
              status: "not_polarized",
              statusLabel: "Not polarized",
              explanation: "The exact 2.00 boundary is not polarized.",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Cycling Polarization")).toBeTruthy();
    expect(screen.getByText("Not polarized")).toBeTruthy();
    expect(screen.getByText("The exact 2.00 boundary is not polarized.")).toBeTruthy();
    expect(screen.getByText("80% easy · 10% threshold · 10% high")).toBeTruthy();
  });

  it("renders the server insufficient-data status instead of inventing a classification", () => {
    render(
      <TrainingDistributionCards
        intensityDistribution={null}
        polarization={{
          model: "treff-three-zone",
          activityScope: "cycling",
          threshold: 2,
          maxHr: null,
          explanation: "Server-provided Treff explanation.",
          weeks: [
            {
              week: "2026-07-20",
              z1Seconds: 3600,
              z2Seconds: 0,
              z3Seconds: 600,
              polarizationIndex: null,
              totalSeconds: 4200,
              zonePercentages: { z1: 85.7, z2: 0, z3: 14.3 },
              status: "insufficient_data",
              statusLabel: "Insufficient data",
              explanation: "Polarization needs time in every Treff zone.",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("Insufficient data")).toBeTruthy();
    expect(screen.getByText("Polarization needs time in every Treff zone.")).toBeTruthy();
  });
});
