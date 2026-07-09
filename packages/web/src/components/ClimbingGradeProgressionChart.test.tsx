// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({
    empty,
    emptyMessage,
    option,
  }: {
    empty?: boolean;
    emptyMessage?: string;
    option: Record<string, unknown>;
  }) => <div data-testid="chart">{empty ? emptyMessage : JSON.stringify(option)}</div>,
}));

import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart.tsx";

afterEach(cleanup);

describe("ClimbingGradeProgressionChart", () => {
  it("renders an empty state when no progression rows exist", () => {
    render(<ClimbingGradeProgressionChart data={[]} />);

    expect(screen.getByText("No climbing grade progression")).toBeTruthy();
  });

  it("renders boulder and route progression with normalized grades", () => {
    render(
      <ClimbingGradeProgressionChart
        data={[
          {
            date: "2026-07-01",
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V3",
            gradeSortValue: 3,
          },
          {
            date: "2026-07-02",
            climbType: "route",
            gradeSystem: "yds",
            grade: "5.10a",
            gradeSortValue: 5101,
          },
        ]}
      />,
    );

    expect(screen.getByText("Boulder")).toBeTruthy();
    expect(screen.getByText("Route")).toBeTruthy();
    expect(screen.getByText("V3")).toBeTruthy();
    expect(screen.getByText("5.10a")).toBeTruthy();
    expect(screen.queryByText("5101")).toBeNull();
  });

  it("uses the newest row per climb type regardless of input order", () => {
    render(
      <ClimbingGradeProgressionChart
        data={[
          {
            date: "2026-07-09",
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V5",
            gradeSortValue: 5,
          },
          {
            date: "2026-07-08",
            climbType: "route",
            gradeSystem: "yds",
            grade: "5.11a",
            gradeSortValue: 5111,
          },
          {
            date: "2026-07-10",
            climbType: "boulder",
            gradeSystem: "v_scale",
            grade: "V3",
            gradeSortValue: 3,
          },
          {
            date: "2026-07-11",
            climbType: "route",
            gradeSystem: "yds",
            grade: "5.10a",
            gradeSortValue: 5101,
          },
        ]}
      />,
    );

    expect(screen.getByText("V3")).toBeTruthy();
    expect(screen.getByText("5.10a")).toBeTruthy();
    expect(screen.queryByText("V5")).toBeNull();
    expect(screen.queryByText("5.11a")).toBeNull();
  });
});
