// @vitest-environment jsdom

import { climbingDemonstratedGradeSchema } from "@dofek/training/climbing-demonstrated-grade";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Linking } from "react-native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClimbingDemonstratedGrade } from "./ClimbingDemonstratedGrade.tsx";
import { demonstratedGradeFixture } from "./climbing-demonstrated-grade-fixture.ts";

const mockRouterPush = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mockRouterPush }) }));

function expanded(name: string) {
  return screen.getByRole("button", { name }).getAttribute("aria-expanded");
}

afterEach(() => {
  vi.mocked(Linking.openURL).mockClear();
  mockRouterPush.mockClear();
});

describe("ClimbingDemonstratedGrade", () => {
  it("renders the approved four-row matrix from the server result only", () => {
    render(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);

    expect(screen.getByText("Demonstrated grade")).toBeTruthy();
    expect(screen.getByText("Aug 22 – Nov 21, 2026")).toBeTruthy();
    expect(
      screen.getByText(
        "Highest published grade sent on three different climbs in the past three months.",
      ),
    ).toBeTruthy();
    for (const label of [
      "Climbing type",
      "Indoor",
      "Outdoor",
      "Bouldering",
      "Lead",
      "Top rope",
      "Unroped",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByText("—")).toHaveLength(5);
    expect(screen.getByText("— Insufficient evidence for a demonstrated grade")).toBeTruthy();
    expect(screen.getByText("How 3:3:3 works")).toBeTruthy();

    expect(expanded("Indoor bouldering, V5, 3 climbs")).toBe("true");
    expect(expanded("Outdoor bouldering, V4, 3 climbs")).toBe("false");
    expect(expanded("Outdoor lead, 5.11a, 3 climbs")).toBe("false");
  });

  it("toggles one evidence disclosure at a time", () => {
    render(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);

    expect(screen.getByText("Indoor bouldering · V5 · V Scale")).toBeTruthy();
    expect(screen.queryByText("Outdoor bouldering · V4 · V Scale")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Outdoor bouldering, V4, 3 climbs" }));
    expect(expanded("Indoor bouldering, V5, 3 climbs")).toBe("false");
    expect(screen.getByText("Outdoor bouldering · V4 · V Scale")).toBeTruthy();
    expect(screen.queryByText("Indoor bouldering · V5 · V Scale")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Outdoor bouldering, V4, 3 climbs" }));
    expect(expanded("Outdoor bouldering, V4, 3 climbs")).toBe("false");
    expect(screen.queryByText("Outdoor bouldering · V4 · V Scale")).toBeNull();
  });

  it("links evidence to the activity and source without computing grades", () => {
    render(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);

    const panel = screen.getByText("Indoor bouldering · V5 · V Scale").parentElement;
    if (!panel) throw new Error("Missing evidence panel");
    expect(within(panel).getAllByText("Green Overhang")).toHaveLength(1);
    expect(within(panel).getByText(/Flash/)).toBeTruthy();
    expect(within(panel).getByText(/Redpoint/)).toBeTruthy();
    expect(within(panel).getByText(/Ascent style unknown/)).toBeTruthy();
    expect(within(panel).getByText("Nov 12")).toBeTruthy();

    const climb = within(panel).getAllByText("Green Overhang")[0];
    const source = within(panel).getAllByRole("link", { name: "Open KAYA source" })[0];
    if (!climb || !source) throw new Error("Missing evidence links");
    fireEvent.click(climb);
    expect(mockRouterPush).toHaveBeenCalledWith("/activity/activity-1");
    fireEvent.click(source);
    expect(Linking.openURL).toHaveBeenCalledWith("https://example.test/climb-1");
  });

  it("uses bounded dates and qualifies partial access", () => {
    const data = {
      ...demonstratedGradeFixture,
      coverage: { fullWindow: false, startDate: "2026-10-01", endDate: "2026-11-21" },
    };
    render(<ClimbingDemonstratedGrade data={data} />);

    expect(screen.getByText("Oct 1 – Nov 21, 2026")).toBeTruthy();
    expect(
      screen.getByText("Limited to the climbing history available to your account."),
    ).toBeTruthy();
  });

  it("does not show bounded dates when no part of the window is accessible", () => {
    const data = {
      ...demonstratedGradeFixture,
      coverage: { fullWindow: false, startDate: null, endDate: null },
    };
    render(<ClimbingDemonstratedGrade data={data} />);

    expect(screen.getByText("Aug 22 – Nov 21, 2026")).toBeTruthy();
    expect(
      screen.getByText("No climbing history is available to your account for this period."),
    ).toBeTruthy();
    expect(screen.queryByText(/Limited to/)).toBeNull();
  });

  it("keeps stale grades visible beside a refresh error", () => {
    render(
      <ClimbingDemonstratedGrade
        data={demonstratedGradeFixture}
        error={new Error("Demonstrated grades unavailable")}
      />,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Demonstrated grades unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Indoor bouldering, V5, 3 climbs" })).toBeTruthy();
  });

  it("separates loading, error and empty states", () => {
    const { rerender } = render(<ClimbingDemonstratedGrade loading />);
    expect(screen.getByText("Loading demonstrated grades…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /bouldering/ })).toBeNull();

    rerender(<ClimbingDemonstratedGrade error={new Error("Demonstrated grades unavailable")} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /bouldering/ })).toBeNull();

    rerender(
      <ClimbingDemonstratedGrade
        data={{
          ...demonstratedGradeFixture,
          cells: demonstratedGradeFixture.cells.map((cell) => ({ ...cell, grades: [] })),
        }}
      />,
    );
    expect(screen.getByText("No demonstrated grades in this period.")).toBeTruthy();
    expect(screen.getByText("— Insufficient evidence for a demonstrated grade")).toBeTruthy();
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

    expect(screen.getByText("Indoor bouldering · V5 · V Scale · V5 (5.8)")).toBeTruthy();
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
    const panel = screen.getByText("Outdoor top rope · 5.11a · French").parentElement;
    if (!panel) throw new Error("Missing evidence panel");
    expect(within(panel).getByText(/Flash · Follow/)).toBeTruthy();
    expect(within(panel).getByText(/Top rope/)).toBeTruthy();

    rerender(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);
    expect(screen.queryByRole("button", { name: "Outdoor top rope, 5.11a, 3 climbs" })).toBeNull();
  });

  it("renders a plain label when evidence has no activity link", () => {
    const baseSend = demonstratedGradeFixture.cells[0]?.grades[0]?.sends[0];
    if (!baseSend) throw new Error("Missing fixture evidence");
    const data = climbingDemonstratedGradeSchema.parse({
      ...demonstratedGradeFixture,
      cells: demonstratedGradeFixture.cells.map((cell) =>
        cell.type === "bouldering" && cell.setting === "indoor"
          ? {
              ...cell,
              grades: [{ ...(cell.grades[0] ?? {}), sends: [{ ...baseSend, activityId: null }] }],
            }
          : cell,
      ),
    });
    render(<ClimbingDemonstratedGrade data={data} />);

    expect(screen.getAllByText("Green Overhang")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Open Green Overhang activity" })).toBeNull();
  });

  it("recovers the first available panel when the chosen cell disappears but honors collapse", () => {
    const { rerender } = render(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);
    fireEvent.click(screen.getByRole("button", { name: "Outdoor lead, 5.11a, 3 climbs" }));
    expect(screen.getByText("Outdoor lead · 5.11a · French")).toBeTruthy();

    const withoutLead = climbingDemonstratedGradeSchema.parse({
      ...demonstratedGradeFixture,
      cells: demonstratedGradeFixture.cells.map((cell) =>
        cell.type === "lead" && cell.setting === "outdoor" ? { ...cell, grades: [] } : cell,
      ),
    });
    rerender(<ClimbingDemonstratedGrade data={withoutLead} />);
    expect(screen.queryByText("Outdoor lead · 5.11a · French")).toBeNull();
    expect(screen.getByText("Indoor bouldering · V5 · V Scale")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Indoor bouldering, V5, 3 climbs" }));
    rerender(<ClimbingDemonstratedGrade data={demonstratedGradeFixture} />);
    expect(screen.queryByText("Indoor bouldering · V5 · V Scale")).toBeNull();
  });
});
