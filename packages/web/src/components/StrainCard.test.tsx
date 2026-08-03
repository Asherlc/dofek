/** @vitest-environment jsdom */
import { duration } from "@dofek/scoring/tokens";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StrainCard } from "./StrainCard.tsx";

const mockUseCountUp = vi.hoisted(() => vi.fn((value: number) => value));

vi.mock("../lib/chartTheme.ts", () => ({
  chartThemeColors: { gridLine: "#333" },
}));

vi.mock("../hooks/useCountUp.ts", () => ({
  useCountUp: mockUseCountUp,
}));

describe("StrainCard", () => {
  afterEach(() => {
    mockUseCountUp.mockClear();
  });

  it("does not use a prior displayed strain as today's strain fallback", () => {
    render(
      <StrainCard
        data={{
          context: {
            label: "Recent-to-baseline workload ratio",
            description:
              "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
            recentDays: 5,
            baselineDays: 20,
          },
          displayedStrain: 13,
          displayedDate: "2026-03-27",
          timeSeries: [
            {
              date: "2026-03-28",
              dailyLoad: 0,
              strain: 0,
              acuteLoad: 133,
              chronicLoad: 33,
              workloadRatio: 4,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByText("13")).toBeNull();
    expect(screen.getByText("0")).toBeTruthy();
    expect(screen.getByText("Last training: Mar 27")).toBeTruthy();
    expect(screen.getByText("Recent 5-day load")).toBeTruthy();
    expect(screen.getByText("20-day baseline load")).toBeTruthy();
    expect(screen.getByText("Recent-to-baseline workload ratio")).toBeTruthy();
    expect(
      screen.getByText(
        "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
      ),
    ).not.toBeVisible();
    expect(
      screen.getByText("Technical name: Acute-to-chronic workload ratio (ACWR)"),
    ).not.toBeVisible();
    expect(screen.getByText("How this is calculated")).toBeVisible();
  });

  it("uses the standard count-up duration for the visible strain value", () => {
    render(
      <StrainCard
        data={{
          context: {
            label: "Recent-to-baseline workload ratio",
            description:
              "Compares load from the latest 7 days with an equivalent 7-day baseline from the latest 28 days. This is descriptive context, not a safe range or an injury prediction.",
            recentDays: 7,
            baselineDays: 28,
          },
          displayedStrain: 13,
          displayedDate: "2026-03-28",
          timeSeries: [
            {
              date: "2026-03-28",
              dailyLoad: 100,
              strain: 13,
              acuteLoad: 133,
              chronicLoad: 33,
              workloadRatio: 4,
            },
          ],
        }}
      />,
    );

    expect(mockUseCountUp).toHaveBeenCalledWith(13, duration.countUp, 1);
  });
});
