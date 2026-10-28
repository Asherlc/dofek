// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers";

function measureChart() {
  const plot = screen.getByRole("image").querySelector('view[style*="height"]');
  if (!plot) throw new Error("Expected measured chart container");
  fireEvent(plot, new CustomEvent("layout", { detail: { width: 320, height: 222, x: 0, y: 0 } }));
  return plot;
}

describe("ClimbingGradeProgressionChart", () => {
  it("renders mixed native grades in one chart using the server's combined daily rates", () => {
    const data = climbingProgressionFixture();
    data.periods = data.periods.slice(0, 1);
    const period = data.periods[0];
    if (!period) throw new Error("Expected recorded fixture period");
    period.unknownOutcomes = 1;
    render(<ClimbingGradeProgressionChart data={data} />);
    expect(screen.getAllByRole("image", { name: /^Grade progression/ })).toHaveLength(1);
    expect(screen.getByText("V4")).toBeTruthy();
    expect(screen.getByText("5.11a")).toBeTruthy();
    const plot = measureChart();
    const bars = plot.querySelectorAll('rect:not([fill="transparent"])');
    expect(bars).toHaveLength(2);
    expect(Number(bars[0]?.getAttribute("x"))).toBeCloseTo(113.2);
    expect(Number(bars[1]?.getAttribute("x"))).toBeCloseTo(113.2);
    expect(Number(bars[0]?.getAttribute("y"))).toBeCloseTo(112);
    expect(Number(bars[0]?.getAttribute("height"))).toBeCloseTo(80);
    expect(Number(bars[1]?.getAttribute("y"))).toBeCloseTo(72);
    expect(Number(bars[1]?.getAttribute("height"))).toBeCloseTo(40);
    fireEvent.click(screen.getByRole("button", { name: "View Grade progression data" }));
    expect(
      within(screen.getByRole("list")).getByLabelText(
        "Jul 2026 · Total: 2.0 sends/day · 6 sends · 3 recorded days · 1 outcome unrecorded",
      ),
    ).toBeTruthy();
    expect(screen.getByText("1.3 sends/day · 4 sends · 3 recorded days")).toBeTruthy();
    expect(screen.getByText("0.7 sends/day · 2 sends · 3 recorded days")).toBeTruthy();
  });

  it("distinguishes identical native grade labels on different scales", () => {
    const data = climbingProgressionFixture();
    data.grades = [
      {
        key: "boulder-v4",
        climbKind: "boulder",
        gradeSystem: "font",
        grade: "6a",
        gradeSortValue: 65,
      },
      {
        key: "route-5.11a",
        climbKind: "route",
        gradeSystem: "french",
        grade: "6a",
        gradeSortValue: 65,
      },
    ];
    render(<ClimbingGradeProgressionChart data={data} />);
    expect(screen.getByText("6a · Fontainebleau")).toBeTruthy();
    expect(screen.getByText("6a · French")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View Grade progression data" }));
    expect(screen.getByText("Jul 2026 · 6a · Fontainebleau")).toBeTruthy();
    expect(screen.getByText("Jul 2026 · 6a · French")).toBeTruthy();
  });

  it("keeps selected period details current after a refresh and hides removed periods", () => {
    const { rerender } = render(
      <ClimbingGradeProgressionChart data={climbingProgressionFixture()} />,
    );
    const periodTarget = measureChart().querySelector('rect[fill="transparent"]');
    if (!periodTarget) throw new Error("Expected interactive period");
    fireEvent.click(periodTarget);
    expect(screen.getByRole("button", { name: "Close period details" })).toBeTruthy();
    expect(screen.getByText("2.0 sends/day · 6 sends · 3 recorded days")).toBeTruthy();

    const refreshed = climbingProgressionFixture();
    const period = refreshed.periods[0];
    if (!period) throw new Error("Expected recorded fixture period");
    period.sends = 8;
    period.sendsPerDay = 8 / 3;
    period.segments = [
      { gradeKey: "boulder-v4", sends: 8, sendsPerDay: 8 / 3, stackStart: 0, stackEnd: 8 / 3 },
    ];
    rerender(<ClimbingGradeProgressionChart data={refreshed} />);
    expect(screen.getByText("2.7 sends/day · 8 sends · 3 recorded days")).toBeTruthy();
    expect(screen.queryByText("2.0 sends/day · 6 sends · 3 recorded days")).toBeNull();

    refreshed.periods = refreshed.periods.slice(1);
    rerender(<ClimbingGradeProgressionChart data={refreshed} />);
    expect(screen.queryByRole("button", { name: "Close period details" })).toBeNull();
  });

  it("keeps recorded zero distinct from missing periods in the plot and accessible data", () => {
    render(<ClimbingGradeProgressionChart data={climbingProgressionFixture()} />);
    measureChart();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getAllByText("0")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "View Grade progression data" }));
    expect(
      screen.getByLabelText("Aug 2026 · Total: 0.0 sends/day · 0 sends · 1 recorded day"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Sep 2026 · Total: No recorded days")).toBeTruthy();
  });

  it("distinguishes loading and empty states", () => {
    const { rerender } = render(<ClimbingGradeProgressionChart data={null} loading />);
    expect(screen.getByText("Loading climbing grades…")).toBeTruthy();
    rerender(<ClimbingGradeProgressionChart data={null} />);
    expect(screen.getByText("No recorded climbing grades")).toBeTruthy();
  });
});
