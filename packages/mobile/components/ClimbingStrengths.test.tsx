import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ClimbingStrengths } from "./ClimbingStrengths";
import {
  climbingStrengthsComparisonFixture,
  climbingStrengthsUnknownResultsFixture,
  climbingStrengthsFixture as fixture,
} from "./climbing-strengths-fixtures";
import { climbingStrengthsSingleClimbFixture } from "./climbing-strengths-single-climb-fixture";

const data = {
  ...fixture,
  panels: fixture.panels.filter((panel) => panel.contextKey === "boulder-v"),
};
const openExternalUrl = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../lib/open-external-url", () => ({ openExternalUrl }));
const push = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
function openData() {
  const disclosure = screen.queryByRole("button", { name: "View Strengths and weaknesses data" });
  if (disclosure) fireEvent.click(disclosure);
}

it("explains missing wall angles and keeps the single recorded style directly selectable", () => {
  const panel = data.panels[0];
  if (!panel) throw new Error("Missing fixture");
  const row = panel.rows[0];
  const pooled = panel.allGrades.rows[0];
  if (!row || !pooled) throw new Error("Missing fixture row");
  render(
    <ClimbingStrengths
      data={{
        ...data,
        panels: [
          {
            ...panel,
            rows: [row],
            allGrades: { ...panel.allGrades, rows: [pooled] },
            coverage: { ...panel.coverage, missingTraits: 59 },
          },
        ],
      }}
    />,
  );
  expect(screen.getByText(/Wall angle is missing for 59 climbs/)).toBeTruthy();
  expect(screen.queryByText(/Outside the dashed line/)).toBeNull();
  expect(screen.queryByRole("image")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^Slab:/ }));
  expect(screen.getByText("Sent 2 of 7 climbs")).toBeTruthy();
});
it("identifies missing hold types when the selected breakdown has no observations", () => {
  const panel = data.panels[0];
  if (!panel) throw new Error("Missing fixture");
  render(
    <ClimbingStrengths
      data={{
        ...data,
        panels: [
          {
            ...panel,
            dimension: "hold_type",
            rows: [],
            allGrades: { ...panel.allGrades, rows: [] },
            coverage: { ...panel.coverage, missingTraits: 60 },
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("Hold type is missing for 60 climbs.")).toBeTruthy();
});
it.each([
  {
    state: "the empty contract fallback",
    missingTraits: 0,
    message: "No recorded hold type observations in this context.",
  },
  {
    state: "one climb without hold types",
    missingTraits: 1,
    message: "Hold type is missing for 1 climb.",
  },
])("keeps $state navigable", ({ missingTraits, message }) => {
  const panel = data.panels[0];
  if (!panel) throw new Error("Missing fixture");
  const singleClimb = { sends: 1, climbs: 1, unknownOutcomes: 0, successRate: 100 };
  render(
    <ClimbingStrengths
      data={{
        coverage: { unknownOutcomes: 0, missingGrades: 0, missingIdentity: 0 },
        panels: [
          {
            ...panel,
            key: "empty-holds",
            dimension: "hold_type",
            grades: missingTraits === 1 ? [{ grade: "V4", gradeSortValue: 4, ...singleClimb }] : [],
            rows: [],
            progress: [],
            gradeAdjustedStrengths: [],
            allGrades: {
              grades:
                missingTraits === 1
                  ? [{ grade: "All grades", gradeSortValue: 0, ...singleClimb }]
                  : [],
              rows: [],
              progress: [],
            },
            coverage: { missingTraits, unknownOutcomes: 0 },
          },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByText(message)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hold type" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
  expect(screen.getByText("No recorded wall angle observations in this context.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByText(message)).toBeTruthy();
});

it("keeps source-climb selection after a refreshed response and opens its source and activity", async () => {
  const result = render(<ClimbingStrengths data={climbingStrengthsComparisonFixture} />);
  openData();
  fireEvent.click(screen.getByRole("button", { name: /^0°:/ }));
  result.rerender(<ClimbingStrengths data={structuredClone(climbingStrengthsComparisonFixture)} />);
  expect(screen.getByText("Quiet Feet")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Mountain Project source for Quiet Feet" }));
  expect(openExternalUrl).toHaveBeenCalledWith(
    "https://www.mountainproject.com/route/1",
    "climbing-strengths-source",
  );
  fireEvent.click(screen.getByRole("button", { name: "View activity for Quiet Feet" }));
  expect(push).toHaveBeenCalledWith("/activity/activity-1");
});
it("keeps empty source examples explicit for a selected style", () => {
  render(<ClimbingStrengths data={data} />);
  openData();
  fireEvent.click(screen.getByRole("button", { name: /^Slab:/ }));
  expect(screen.getByText("No examples available for this selection.")).toBeTruthy();
  expect(screen.getByText("Sent 2 of 7 climbs")).toBeTruthy();
});
it("uses an observed hold-type panel by default and keeps missing dimensions navigable", () => {
  const panels = data.panels.map((panel) =>
    panel.dimension === "wall_angle" ? { ...panel, rows: [] } : panel,
  );
  render(<ClimbingStrengths data={{ ...data, panels }} />);
  expect(screen.getByRole("button", { name: "Hold type" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
  expect(screen.getByText("Wall angle is missing for 7 climbs.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  openData();
  expect(screen.getByRole("button", { name: /^Crimps:/ })).toBeTruthy();
});
it("separates initial loading, empty, error and cached refresh states", () => {
  const result = render(<ClimbingStrengths data={undefined} loading />);
  expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  result.rerender(
    <ClimbingStrengths data={data} loading error={{ message: "Reconnect provider" }} />,
  );
  expect(screen.getByText("Reconnect provider")).toBeTruthy();
  openData();
  expect(screen.getByRole("button", { name: /^Slab:/ })).toBeTruthy();
  result.rerender(<ClimbingStrengths data={{ ...data, panels: [] }} />);
  expect(screen.getByText("No recorded climbing outcomes in this period")).toBeTruthy();
});
it("keeps recorded unknown results in the selected style's source climbs", () => {
  render(<ClimbingStrengths data={climbingStrengthsUnknownResultsFixture} />);
  openData();
  fireEvent.click(screen.getByRole("button", { name: /^Vertical:/ }));
  expect(screen.getByText(/V3 · .* · Result unknown/)).toBeTruthy();
  expect(screen.getByText("Known ascent")).toBeTruthy();
  expect(screen.getByText("Success rates use climbs with known results.")).toBeTruthy();
});
it("uses styles and progress views for both breakdowns", () => {
  render(<ClimbingStrengths data={data} />);
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  openData();
  expect(screen.getByRole("button", { name: /^Crimps:/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));
  expect(screen.getByText("Monthly send rate")).toBeTruthy();
});

it("opens the recorded climb with a clear small-sample explanation", () => {
  render(<ClimbingStrengths data={climbingStrengthsSingleClimbFixture} />);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Slab: Sent 1 of 1 climb · Too few climbs to judge strengths yet",
    }),
  );
  expect(screen.getByText("Sent 1 of 1 climb")).toBeTruthy();
  expect(screen.getByText("Too few climbs to judge strengths yet")).toBeTruthy();
  expect(screen.getByText("Quiet Feet")).toBeTruthy();
});

it("selects source categories independently across Styles and Progress", async () => {
  const { climbingStrengthsTagsFixture: tagged } = await import("./climbing-strengths-fixtures");
  render(<ClimbingStrengths data={tagged} />);
  const category = screen.getByRole("button", { name: "Kaya · Movement" });
  fireEvent.click(category);
  expect(category.getAttribute("aria-selected")).toBe("true");

  openData();
  expect(screen.getAllByText(/Custom movement/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));

  expect(screen.getAllByText(/Custom movement/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "custom-source · Movement" }));
  {
    const disclosure = screen.queryByRole("button", { name: /View .* data/ });
    if (disclosure) fireEvent.click(disclosure);
  }
  expect(screen.getAllByText(/Other movement/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Kaya · Session mood" }));
  {
    const disclosure = screen.queryByRole("button", { name: /View .* data/ });
    if (disclosure) fireEvent.click(disclosure);
  }
  expect(screen.getAllByText(/Unfamiliar/).length).toBeGreaterThan(0);
});
it("prefers observed tags when wall and hold observations are missing", async () => {
  const { climbingStrengthsTagsFixture: tagged } = await import("./climbing-strengths-fixtures");
  render(
    <ClimbingStrengths
      data={{ ...tagged, panels: tagged.panels.map((panel) => ({ ...panel, rows: [] })) }}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Kaya · Movement" }).getAttribute("aria-selected"),
  ).toBe("true");
});
