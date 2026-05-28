/** @vitest-environment jsdom */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StrainCard } from "./StrainCard.tsx";

vi.mock("../lib/chartTheme.ts", () => ({
  chartThemeColors: { gridLine: "#333" },
}));

vi.mock("../hooks/useCountUp.ts", () => ({
  useCountUp: (value: number) => value,
}));

describe("StrainCard", () => {
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
});
