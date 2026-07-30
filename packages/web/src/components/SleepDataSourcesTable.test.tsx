/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type SleepDataSourceRow, SleepDataSourcesTable } from "./SleepDataSourcesTable.tsx";

function row(day: number): SleepDataSourceRow {
  return {
    date: `2026-03-${String(day).padStart(2, "0")}`,
    durationMinutes: 480,
    providerId: "whoop",
    sourceName: `Source ${day}`,
    sourceProviders: [],
    selectedSessionId: `00000000-0000-4000-8000-${String(day).padStart(12, "0")}`,
    startedAt: `2026-03-${String(day).padStart(2, "0")}T06:00:00Z`,
    endedAt: `2026-03-${String(day).padStart(2, "0")}T14:00:00Z`,
    localTimeContext: {
      timezone: "UTC",
      startUtcOffsetMinutes: 0,
      endUtcOffsetMinutes: 0,
      source: "provider_timezone",
    },
    overlappingSessions: [],
    stagingAvailable: true,
  };
}

describe("SleepDataSourcesTable", () => {
  it("paginates sleep nights newest first", () => {
    render(
      <SleepDataSourcesTable rows={Array.from({ length: 21 }, (_, index) => row(index + 1))} />,
    );

    expect(screen.getByText(/Source 21/)).toBeDefined();
    expect(screen.queryByText(/Source 1$/)).toBeNull();
    expect(screen.getByText("1 / 2")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Next nights page" }));

    expect(screen.getByText(/Source 1$/)).toBeDefined();
    expect(screen.queryByText(/Source 21/)).toBeNull();
    expect(screen.getByText("2 / 2")).toBeDefined();
  });

  it("labels nights without a stage breakdown as partial", () => {
    render(<SleepDataSourcesTable rows={[{ ...row(1), stagingAvailable: false }]} />);

    expect(screen.getByText("Partial")).toBeDefined();
  });

  it("identifies the selected session and discloses canonical overlaps", () => {
    render(
      <SleepDataSourcesTable
        rows={[
          {
            ...row(1),
            providerId: "whoop",
            sourceName: "WHOOP 4.0",
            sourceProviders: ["apple_health", "whoop"],
            overlappingSessions: [
              {
                sessionId: "00000000-0000-4000-8000-000000001775",
                providerId: "oura",
                sourceName: "Oura Ring",
                sourceProviders: ["oura"],
                localTimeContext: {
                  timezone: null,
                  startUtcOffsetMinutes: -420,
                  endUtcOffsetMinutes: -420,
                  source: "provider_offset",
                },
                startedAt: "2026-03-02T06:30:00Z",
                endedAt: "2026-03-02T12:00:00Z",
                durationMinutes: 330,
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Selected session")).toBeDefined();
    expect(screen.getByText("Merged sources")).toBeDefined();
    expect(screen.getByText("WHOOP (Cloud) · WHOOP 4.0")).toBeDefined();
    expect(screen.getByText("Apple Health")).toBeDefined();

    const reviewButton = screen.getByRole("button", { name: "Review 1 overlap" });
    expect(reviewButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(reviewButton);

    expect(reviewButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Oura · Oura Ring")).toBeDefined();
    expect(screen.getByText(/5h 30m/)).toBeDefined();
  });

  it("keeps the selected start time visible when the end is unavailable", () => {
    render(<SleepDataSourcesTable rows={[{ ...row(1), endedAt: null }]} />);

    expect(screen.getByText("6:00 AM – End unavailable")).toBeDefined();
    expect(screen.queryByText("Local time unavailable")).toBeNull();
  });
});
