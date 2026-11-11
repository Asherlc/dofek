// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "react-native";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => true),
}));

import { TrainingDistributionCards } from "./TrainingDistributionCards";

describe("TrainingDistributionCards", () => {
  it("renders zone values and provides the calculation method", () => {
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

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

    expect(screen.getByText("Heart-rate zone distribution")).toBeTruthy();
    expect(screen.getByText("Recovery")).toBeTruthy();
    expect(screen.getByText("25%")).toBeTruthy();
    expect(screen.getByText("Aerobic")).toBeTruthy();
    expect(screen.getByText("75%")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "About How this is calculated for Heart-rate zone distribution",
      }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      "How this is calculated for Heart-rate zone distribution",
      expect.stringContaining("Karvonen"),
      [{ text: "Close" }],
    );
    alertSpy.mockRestore();
  });

  it("renders the server Treff status, zone percentages, and calculation method", () => {
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

    render(
      <TrainingDistributionCards
        intensityDistribution={null}
        polarization={{
          model: "treff-three-zone",
          activityScope: "cycling",
          threshold: 2,
          maxHr: 190,
          explanation: "Server-provided Treff explanation.",
          method: {
            formula: "Server-provided Treff formula.",
            zoneBasis: "Server-provided zone basis.",
            calculationChoice: "Server-provided calculation choice.",
            interpretation: "Server-provided descriptive interpretation.",
            source: {
              title: "Treff source",
              url: "https://doi.org/10.3389/fphys.2019.00707",
            },
          },
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

    expect(screen.getByText("Easy-to-hard training balance")).toBeTruthy();
    expect(screen.getByText("Not polarized")).toBeTruthy();
    expect(screen.getByText("80% easy · 10% threshold · 10% high")).toBeTruthy();
    expect(screen.getByText("Easy-to-hard balance 2.000")).toBeTruthy();
    expect(screen.queryByText("Server-provided Treff formula.")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "About How this is calculated for Easy-to-hard training balance",
      }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      "How this is calculated for Easy-to-hard training balance",
      expect.stringContaining("Technical name: Polarization Index"),
      [{ text: "Close" }],
    );
    alertSpy.mockRestore();
  });

  it("renders the server insufficient-data status instead of inventing a classification", () => {
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});

    render(
      <TrainingDistributionCards
        intensityDistribution={null}
        polarization={{
          model: "treff-three-zone",
          activityScope: "cycling",
          threshold: 2,
          maxHr: null,
          explanation: "Server-provided Treff explanation.",
          method: {
            formula: "Server-provided Treff formula.",
            zoneBasis: "Server-provided zone basis.",
            calculationChoice: "Server-provided calculation choice.",
            interpretation: "Server-provided descriptive interpretation.",
            source: {
              title: "Treff source",
              url: "https://doi.org/10.3389/fphys.2019.00707",
            },
          },
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
    fireEvent.click(
      screen.getByRole("button", {
        name: "About How this is calculated for Easy-to-hard training balance",
      }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      "How this is calculated for Easy-to-hard training balance",
      expect.stringContaining("Server-provided Treff formula."),
      [{ text: "Close" }],
    );
    alertSpy.mockRestore();
  });
});
