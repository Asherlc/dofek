// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SleepSourceReview } from "./SleepSourceReview";

const selectedSessionId = "00000000-0000-4000-8000-000000001774";

describe("SleepSourceReview", () => {
  it("identifies the selected session and exposes overlapping canonical sessions", () => {
    render(
      <SleepSourceReview
        nights={[
          {
            date: "2026-03-01",
            durationMinutes: 480,
            providerId: "whoop",
            sourceName: "WHOOP 4.0",
            sourceProviders: ["apple_health", "whoop"],
            selectedSessionId,
            startedAt: "2026-03-02T06:00:00Z",
            endedAt: "2026-03-02T14:00:00Z",
            localTimeContext: {
              timezone: null,
              startUtcOffsetMinutes: -420,
              endUtcOffsetMinutes: -420,
              source: "provider_offset",
            },
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

    expect(screen.getByText("WHOOP (Cloud) · WHOOP 4.0")).toBeTruthy();
    expect(screen.getByText("Merged with Apple Health")).toBeTruthy();

    const reviewButton = screen.getByRole("button", { name: "Review 1 overlap" });
    expect(reviewButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(reviewButton);

    expect(reviewButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Oura · Oura Ring")).toBeTruthy();
    expect(screen.getByText(/5h 30m/)).toBeTruthy();
  });

  it("states when the selected session has no canonical conflicts", () => {
    render(
      <SleepSourceReview
        nights={[
          {
            date: "2026-03-01",
            durationMinutes: 480,
            providerId: "whoop",
            sourceName: null,
            sourceProviders: ["whoop"],
            selectedSessionId,
            startedAt: "2026-03-02T06:00:00Z",
            endedAt: "2026-03-02T14:00:00Z",
            localTimeContext: {
              timezone: "UTC",
              startUtcOffsetMinutes: 0,
              endUtcOffsetMinutes: 0,
              source: "provider_timezone",
            },
            overlappingSessions: [],
          },
        ]}
      />,
    );

    expect(screen.getByText("No overlapping sessions")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps the selected start time visible when the end is unavailable", () => {
    render(
      <SleepSourceReview
        nights={[
          {
            date: "2026-03-01",
            durationMinutes: null,
            providerId: "whoop",
            sourceName: null,
            sourceProviders: ["whoop"],
            selectedSessionId,
            startedAt: "2026-03-02T06:00:00Z",
            endedAt: null,
            localTimeContext: {
              timezone: "UTC",
              startUtcOffsetMinutes: 0,
              endUtcOffsetMinutes: null,
              source: "provider_timezone",
            },
            overlappingSessions: [],
          },
        ]}
      />,
    );

    expect(
      screen.getByText(
        (_, element) => element?.textContent === "6:00 AM – End unavailable · Duration unavailable",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Local time unavailable")).toBeNull();
  });
});
