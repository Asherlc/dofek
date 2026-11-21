/** @vitest-environment jsdom */

import { climbingDemonstratedGradeSchema } from "@dofek/training/climbing-demonstrated-grade";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClimbingDemonstratedGrade } from "./ClimbingDemonstratedGrade.tsx";
import { demonstratedGradeFixture } from "./climbing-demonstrated-grade-fixture.ts";

afterEach(cleanup);

describe("ClimbingDemonstratedGrade", () => {
  it("renders the approved four-row matrix from the server result only", () => {
    render(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);

    expect(screen.getByRole("heading", { name: "Demonstrated grade" })).toBeVisible();
    expect(screen.getByText("Aug 22 – Nov 21, 2026")).toBeVisible();
    expect(
      screen.getByText(
        "Highest published grade sent on three different climbs in the past three months.",
      ),
    ).toBeVisible();

    const table = screen.getByRole("table", { name: "Demonstrated grade matrix" });
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    for (const label of ["Bouldering", "Lead", "Top rope", "Unroped"]) {
      expect(within(table).getByRole("rowheader", { name: label })).toBeVisible();
    }
    expect(within(table).getByRole("columnheader", { name: "Indoor" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "Outdoor" })).toBeVisible();

    const indoorBouldering = screen.getByRole("button", {
      name: "Indoor bouldering, V5, 3 climbs",
    });
    expect(indoorBouldering).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "Outdoor bouldering, V4, 3 climbs" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Outdoor lead, 5.11a, 3 climbs" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(table).getAllByText("—")).toHaveLength(5);

    const key = screen.getByText("Insufficient evidence for a demonstrated grade");
    expect(key).toHaveClass("sr-only");
    expect(table).toHaveAttribute("aria-describedby", key.id);
    expect(screen.getByText("How 3:3:3 works")).toBeVisible();
  });

  it("toggles one evidence disclosure at a time", () => {
    render(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);

    expect(screen.getByRole("region", { name: "Indoor bouldering · V5 · V Scale" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Outdoor bouldering · V4 · V Scale" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Outdoor bouldering, V4, 3 climbs" }));
    expect(screen.getByRole("button", { name: "Indoor bouldering, V5, 3 climbs" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Outdoor bouldering, V4, 3 climbs" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("region", { name: "Outdoor bouldering · V4 · V Scale" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Indoor bouldering · V5 · V Scale" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Outdoor bouldering, V4, 3 climbs" }));
    expect(
      screen.getByRole("button", { name: "Outdoor bouldering, V4, 3 climbs" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("region", { name: "Outdoor bouldering · V4 · V Scale" })).toBeNull();
  });

  it("links evidence to the source, activity and dated style without computing grades", () => {
    render(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);

    const panel = screen.getByRole("region", { name: "Indoor bouldering · V5 · V Scale" });
    expect(within(panel).getByRole("link", { name: "Green Overhang" })).toHaveAttribute(
      "href",
      "/activity/activity-1",
    );
    expect(within(panel).getByRole("link", { name: "Green Overhang" })).toHaveClass("text-accent");
    expect(within(panel).getAllByRole("link", { name: "KAYA" })[0]).toHaveAttribute(
      "href",
      "https://example.test/climb-1",
    );
    expect(within(panel).getAllByText("Flash")).toHaveLength(1);
    expect(within(panel).getAllByText("Redpoint")).toHaveLength(1);
    expect(within(panel).getAllByText("Ascent style unknown")).toHaveLength(1);
    expect(within(panel).getByText("Nov 12").closest("time")).toHaveAttribute(
      "datetime",
      "2026-11-12",
    );
  });

  it("uses bounded dates and qualifies partial access", () => {
    const data = {
      ...demonstratedGradeFixture,
      coverage: { fullWindow: false, startDate: "2026-10-01", endDate: "2026-11-21" },
    };
    render(<ClimbingDemonstratedGrade data={data} />);

    expect(screen.getByText("Oct 1 – Nov 21, 2026")).toBeVisible();
    expect(
      screen.getByText("Limited to the climbing history available to your account."),
    ).toBeVisible();
  });

  it("does not show bounded dates when no part of the window is accessible", () => {
    const data = {
      ...demonstratedGradeFixture,
      coverage: { fullWindow: false, startDate: null, endDate: null },
    };
    render(<ClimbingDemonstratedGrade data={data} />);

    expect(screen.getByText("Aug 22 – Nov 21, 2026")).toBeVisible();
    expect(
      screen.getByText("No climbing history is available to your account for this period."),
    ).toBeVisible();
    expect(screen.queryByText(/Limited to/)).toBeNull();
  });

  it("keeps stale grades visible beside a refresh error", () => {
    render(
      <ClimbingDemonstratedGrade
        data={demonstratedGradeFixture}
        error={new Error("Demonstrated grades unavailable")}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Demonstrated grades unavailable");
    expect(screen.getByRole("alert")).toHaveClass("text-danger");
    expect(screen.getByRole("button", { name: "Indoor bouldering, V5, 3 climbs" })).toBeVisible();
  });

  it("separates loading, error and empty states", () => {
    const { rerender } = render(<ClimbingDemonstratedGrade loading />);
    expect(screen.getByText("Loading demonstrated grades…")).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();

    rerender(<ClimbingDemonstratedGrade error={new Error("Demonstrated grades unavailable")} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Demonstrated grades unavailable");
    expect(screen.queryByRole("table")).toBeNull();

    rerender(
      <ClimbingDemonstratedGrade
        data={{
          ...demonstratedGradeFixture,
          cells: demonstratedGradeFixture.cells.map((cell) => ({ ...cell, grades: [] })),
        }}
      />,
    );
    expect(screen.getByRole("table", { name: "Demonstrated grade matrix" })).toBeVisible();
    expect(screen.getByText("No demonstrated grades in this period.")).toBeVisible();
  });

  it("shows the grade system and published label in the supporting evidence", () => {
    render(
      <ClimbingDemonstratedGrade
        data={{
          ...demonstratedGradeFixture,
          cells: demonstratedGradeFixture.cells.map((cell) => {
            if (cell.type !== "bouldering" || cell.setting !== "indoor") return cell;
            const grade = cell.grades[0];
            return { ...cell, grades: grade ? [{ ...grade, publishedLabel: "V5 (5.8)" }] : [] };
          }),
        }}
      />,
    );

    expect(
      screen.getByRole("region", { name: "Indoor bouldering · V5 · V Scale · V5 (5.8)" }),
    ).toBeVisible();
  });

  it("keeps the recorded method visible for pooled top rope evidence", () => {
    const baseSend = demonstratedGradeFixture.cells[0]?.grades[0]?.sends[0];
    const leadGrade = demonstratedGradeFixture.cells.find(
      (cell) => cell.type === "lead" && cell.setting === "outdoor",
    )?.grades[0];
    if (!baseSend || !leadGrade) throw new Error("Missing fixture evidence");
    const data = climbingDemonstratedGradeSchema.parse({
      ...demonstratedGradeFixture,
      cells: demonstratedGradeFixture.cells.map((cell) =>
        cell.type === "top_rope" && cell.setting === "outdoor"
          ? {
              ...cell,
              grades: [
                {
                  ...leadGrade,
                  sends: [
                    {
                      ...baseSend,
                      displayName: "Followed Traverse",
                      ropeMethod: "follow",
                      ascentStyle: "Flash",
                    },
                    {
                      ...baseSend,
                      displayName: "Roped Ledge",
                      ropeMethod: "top_rope",
                      ascentStyle: null,
                    },
                  ],
                },
              ],
            }
          : cell,
      ),
    });
    const { rerender } = render(<ClimbingDemonstratedGrade data={data} />);

    fireEvent.click(screen.getByRole("button", { name: "Outdoor top rope, 5.11a, 3 climbs" }));
    const panel = screen.getByRole("region", { name: "Outdoor top rope · 5.11a · French" });
    expect(within(panel).getByText("Flash · Follow")).toBeVisible();
    expect(within(panel).getByText("Top rope")).toBeVisible();

    rerender(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);
    expect(screen.queryByRole("button", { name: "Outdoor top rope, 5.11a, 3 climbs" })).toBeNull();
  });

  it("recovers the first available panel when the chosen cell disappears but honors collapse", () => {
    const { rerender } = render(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);
    fireEvent.click(screen.getByRole("button", { name: "Outdoor lead, 5.11a, 3 climbs" }));
    expect(screen.getByRole("region", { name: "Outdoor lead · 5.11a · French" })).toBeVisible();

    const withoutLead = climbingDemonstratedGradeSchema.parse({
      ...demonstratedGradeFixture,
      cells: demonstratedGradeFixture.cells.map((cell) =>
        cell.type === "lead" && cell.setting === "outdoor" ? { ...cell, grades: [] } : cell,
      ),
    });
    rerender(<ClimbingDemonstratedGrade data={withoutLead} />);
    expect(screen.queryByRole("region", { name: "Outdoor lead · 5.11a · French" })).toBeNull();
    expect(screen.getByRole("region", { name: "Indoor bouldering · V5 · V Scale" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Indoor bouldering, V5, 3 climbs" }));
    rerender(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);
    expect(screen.queryByRole("region", { name: "Indoor bouldering · V5 · V Scale" })).toBeNull();
  });
});
