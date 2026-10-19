// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClimbingGradeProgressionChart } from "./ClimbingGradeProgressionChart";
import { climbingProgressionFixture } from "./climbing-progression-test-helpers";

describe("ClimbingGradeProgressionChart", () => {
  it("focuses a solo pitch lane independently of another lane with the same method and grade system", () => {
    render(
      <ClimbingGradeProgressionChart
        data={[
          climbingProgressionFixture("route", { ropeMethod: "lead", solo: false }),
          climbingProgressionFixture("route", {
            ropeMethod: "lead",
            solo: true,
            attemptScope: "pitch",
          }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Focus Lead · Solo · Pitch" }));
    expect(screen.getByText("Lead · Solo · Pitch")).toBeTruthy();
    expect(screen.queryByText("Lead")).toBeNull();
  });
  it("distinguishes retained grade scales in style and focus labels", () => {
    const french = climbingProgressionFixture("route", { ropeMethod: "lead" });
    french.gradeSystem = "french";
    french.grades = [{ grade: "6c", gradeSortValue: 65 }];
    french.periods = french.periods.map((period) => ({
      ...period,
      settings: period.settings.map((point) => ({
        ...point,
        segments: point.segments.map((segment) => ({ ...segment, grade: "6c" })),
      })),
    }));
    render(
      <ClimbingGradeProgressionChart
        data={[climbingProgressionFixture("route", { ropeMethod: "lead" }), french]}
      />,
    );
    expect(screen.getByRole("button", { name: "Focus Lead · French" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Focus Lead · Yosemite Decimal System" }),
    ).toBeTruthy();
  });
  it("keeps selected period details current after a refresh and hides removed periods", () => {
    const { rerender } = render(
      <ClimbingGradeProgressionChart data={[climbingProgressionFixture()]} />,
    );
    const plot = screen.getByRole("image").querySelector('view[style*="height"]');
    if (!plot) throw new Error("Expected measured chart container");
    fireEvent(plot, new CustomEvent("layout", { detail: { width: 320, height: 167, x: 0, y: 0 } }));
    const periodTarget = plot.querySelector('rect[fill="transparent"]');
    if (!periodTarget) throw new Error("Expected interactive period");
    fireEvent.click(periodTarget);
    expect(screen.getByRole("button", { name: "Close period details" })).toBeTruthy();
    expect(screen.getByText("2.0 sends/day · 4 sends · 2 recorded days")).toBeTruthy();

    const refreshed = climbingProgressionFixture();
    const indoor = refreshed.periods[0]?.settings[0];
    if (!indoor) throw new Error("Expected indoor fixture");
    indoor.sends = 8;
    indoor.sendsPerDay = 4;
    indoor.segments = [{ grade: "V4", sends: 8, sendsPerDay: 4, stackStart: 0, stackEnd: 4 }];
    rerender(<ClimbingGradeProgressionChart data={[refreshed]} />);
    expect(screen.getByText("4.0 sends/day · 8 sends · 2 recorded days")).toBeTruthy();
    expect(screen.queryByText("2.0 sends/day · 4 sends · 2 recorded days")).toBeNull();

    refreshed.periods = refreshed.periods.slice(1);
    rerender(<ClimbingGradeProgressionChart data={[refreshed]} />);
    expect(screen.queryByRole("button", { name: "Close period details" })).toBeNull();
  });
  it("shows style lanes with a shared sends-per-day scale and exact server values in accessible data", () => {
    render(
      <ClimbingGradeProgressionChart
        data={[
          climbingProgressionFixture(),
          climbingProgressionFixture("route", { ropeMethod: "top_rope" }),
          climbingProgressionFixture("route", { ropeMethod: "lead" }),
          climbingProgressionFixture("boulder", { usedAid: null }),
          climbingProgressionFixture("route", { ropeMethod: "lead", usedAid: null }),
          climbingProgressionFixture("route", { ropeMethod: "lead", usedAid: true }),
          climbingProgressionFixture("route"),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: "Focus Bouldering" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus Top rope" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus Lead" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus Lead · Aid" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View Bouldering data" }));
    expect(screen.getByText("2.0 sends/day · 4 sends · 2 recorded days")).toBeTruthy();
    expect(screen.getByText("0.0 sends/day · 0 sends · 1 recorded day")).toBeTruthy();
    expect(screen.getAllByText("No recorded days")).toHaveLength(2);
  });
  it("focuses a style and isolates outdoor records without changing the server values", () => {
    render(
      <ClimbingGradeProgressionChart
        data={[
          climbingProgressionFixture(),
          climbingProgressionFixture("route", { ropeMethod: "lead" }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Focus Bouldering" }));
    expect(screen.queryByRole("button", { name: "Focus Lead" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Outdoor" }));
    fireEvent.click(screen.getByRole("button", { name: "View Bouldering data" }));
    expect(screen.getByText("0.0 sends/day · 0 sends · 1 recorded day")).toBeTruthy();
    expect(screen.queryByText("2.0 sends/day · 4 sends · 2 recorded days")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All climbs" }));
    expect(screen.getByRole("button", { name: "Focus Lead" })).toBeTruthy();
  });
  it("preserves unknown settings and explains unrecorded outcomes", () => {
    const lane = climbingProgressionFixture("route", { ropeMethod: "lead" });
    lane.settings = ["unknown"];
    lane.periods = lane.periods.map((period) => ({
      ...period,
      settings: period.settings.slice(0, 1).map((setting) => ({
        ...setting,
        setting: "unknown",
        unknownOutcomes: 1,
      })),
    }));
    render(<ClimbingGradeProgressionChart data={[lane]} />);
    expect(screen.getByRole("button", { name: "Focus Lead" })).toBeTruthy();
    expect(screen.getByText(/Unknown setting/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View Lead data" }));
    expect(screen.getByText(/1 outcome unrecorded/)).toBeTruthy();
  });
  it("distinguishes loading and empty states", () => {
    const { rerender } = render(<ClimbingGradeProgressionChart data={[]} loading />);
    expect(screen.getByText("Loading climbing grades…")).toBeTruthy();
    rerender(
      <ClimbingGradeProgressionChart
        data={[
          climbingProgressionFixture("boulder", { usedAid: null }),
          climbingProgressionFixture("route"),
        ]}
      />,
    );
    expect(screen.getByText("No recorded climbing grades")).toBeTruthy();
  });
});
