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
  });

  it("uses the standard count-up duration for the visible strain value", () => {
    render(
      <StrainCard
        data={{
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
