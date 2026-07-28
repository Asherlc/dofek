// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => true),
}));

import { openExternalUrl } from "../lib/open-external-url";
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
        monotony={null}
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
        monotony={null}
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
        monotony={null}
      />,
    );

    expect(screen.getByText("Insufficient data")).toBeTruthy();
    expect(screen.getByText("Polarization needs time in every Treff zone.")).toBeTruthy();
  });

  it("renders server-computed monotony inputs, descriptive method, and source", () => {
    const method = {
      formula:
        "Monotony = 7-day mean daily cycling load ÷ population standard deviation of daily cycling load. Strain = weekly cycling load × monotony.",
      calendar: "Monday–Sunday calendar weeks include zero-load days.",
      activityScope: "Cycling activities with computed endurance training load.",
      interpretation:
        "These are descriptive workload-variability summaries, not an overtraining diagnosis.",
      source: {
        title: "Foster (1998), Monitoring training in athletes",
        url: "https://pubmed.ncbi.nlm.nih.gov/9662690/",
      },
    };

    render(
      <TrainingDistributionCards
        intensityDistribution={null}
        polarization={null}
        monotony={[
          {
            week: "2026-07-20",
            monotony: 2.18,
            strain: 2460,
            weeklyLoad: 1128,
            dailyMeanLoad: 161.14,
            dailyLoadStandardDeviation: 73.92,
            method,
          },
        ]}
      />,
    );

    expect(screen.getByText("Training Monotony & Strain")).toBeTruthy();
    expect(screen.getByText("Monotony 2.18")).toBeTruthy();
    expect(screen.getByText("Strain 2460.0")).toBeTruthy();
    expect(
      screen.getByText("Daily mean 161.14 · population standard deviation (SD) 73.92"),
    ).toBeTruthy();
    expect(screen.getByText(method.formula)).toBeTruthy();
    expect(screen.getByText(method.calendar)).toBeTruthy();
    expect(screen.getByText(method.interpretation)).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: method.source.title }));
    expect(openExternalUrl).toHaveBeenCalledWith(method.source.url, "training-monotony-source");
  });
});
