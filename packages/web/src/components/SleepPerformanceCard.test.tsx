/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SleepPerformanceCard } from "./SleepPerformanceCard.tsx";

vi.mock("../lib/FetchingContext.tsx", () => ({
  useFetchingCount: () => 0,
}));

describe("SleepPerformanceCard", () => {
  it("links the score to the contributing sleep source records", () => {
    render(
      <SleepPerformanceCard
        data={{
          score: 88,
          tier: "Good",
          actualMinutes: 462,
          neededMinutes: 480,
          efficiency: 92,
          recommendedBedtime: "10:30 PM",
          sleepDate: "2026-04-02",
          providerId: "whoop",
          sourceName: "WHOOP 4.0",
          sourceProviders: ["whoop"],
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "View sleep source data" }).getAttribute("href")).toBe(
      "#sleep-data-sources",
    );
  });

  it("does not show an evidence action without sleep data", () => {
    render(<SleepPerformanceCard data={null} />);

    expect(screen.queryByRole("link", { name: "View sleep source data" })).toBeNull();
  });
});
