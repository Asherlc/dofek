/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ClimbingStrengths } from "./ClimbingStrengths.tsx";
import {
  climbingStrengthsUnknownResultsFixture,
  climbingStrengthsFixture as fixture,
} from "./climbing-strengths-fixtures.ts";

vi.mock("./DofekChart.tsx", () => ({
  DofekChart: ({ dataDisclosure }: { dataDisclosure: ReactNode }) => (
    <div>Chart{dataDisclosure}</div>
  ),
}));

afterEach(cleanup);
it("explains missing wall angles and keeps the single recorded style directly selectable", () => {
  const panel = fixture.panels[0];
  if (!panel) throw new Error("Missing fixture");
  const row = panel.rows[0];
  const pooled = panel.allGrades.rows[0];
  if (!row || !pooled) throw new Error("Missing fixture row");
  render(
    <ClimbingStrengths
      data={{
        ...fixture,
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
  expect(screen.getByText(/Wall angle is missing for 59 climbs/)).toBeVisible();
  expect(screen.queryByText(/Outside the dashed line/)).toBeNull();
  expect(screen.queryByText(/Grade-adjusted difference on a/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Vertical · All grades/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "13 sends / 21 climbs",
  );
});
it("identifies missing hold types when the selected breakdown has no observations", () => {
  const panel = fixture.panels[0];
  if (!panel) throw new Error("Missing fixture");
  render(
    <ClimbingStrengths
      data={{
        ...fixture,
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
  expect(screen.getByText("Hold type is missing for 60 climbs.")).toBeVisible();
});
it.each([
  {
    state: "the empty contract fallback",
    missingTraits: 0,
    message: "No recorded hold type observations for this context.",
  },
  {
    state: "one climb without hold types",
    missingTraits: 1,
    message: "Hold type is missing for 1 climb.",
  },
])("keeps $state navigable", ({ missingTraits, message }) => {
  const panel = fixture.panels[0];
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
  expect(screen.getByText(message)).toBeVisible();
  expect(screen.getByRole("button", { name: "Hold type" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
  expect(screen.getByText("No recorded wall angle observations for this context.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByText(message)).toBeVisible();
});
function renderStrengths(element: Parameters<typeof render>[0]) {
  const result = render(element);
  for (const disclosure of screen.queryAllByText("Exact values")) {
    if (!disclosure.closest("details")?.open) fireEvent.click(disclosure);
  }
  return result;
}
it("keeps breakdown controls usable when the period has no panels", () => {
  renderStrengths(<ClimbingStrengths data={{ ...fixture, panels: [] }} />);
  for (const name of ["Wall angle", "Hold type"]) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  }
  expect(screen.getByText("No recorded climbing strengths in this period.")).toBeVisible();
});
it("opens source examples from the selected style", () => {
  renderStrengths(<ClimbingStrengths data={fixture} />);
  fireEvent.click(screen.getByRole("button", { name: /Vertical · All grades/ }));
  expect(screen.getByRole("link", { name: "KAYA" }).getAttribute("href")).toBe(
    "https://kayaclimb.com/climb/example",
  );
  expect(screen.getByRole("link", { name: "View activity" }).getAttribute("href")).toBe(
    "/activity/activity-1",
  );
  expect(screen.getByText("Evening Arete")).toBeVisible();
});
it("keeps cached content during loading and distinguishes initial loading from empty", () => {
  const { rerender } = renderStrengths(<ClimbingStrengths data={undefined} loading />);
  expect(screen.getByLabelText("Loading climbing strengths.")).toBeVisible();
  rerender(<ClimbingStrengths data={fixture} loading />);
  fireEvent.click(screen.getByText("Exact values"));
  expect(screen.getByRole("button", { name: /Vertical · All grades/ })).toBeVisible();
  rerender(<ClimbingStrengths data={{ panels: [], coverage: fixture.coverage }} />);
  expect(screen.getByText("No recorded climbing strengths in this period.")).toBeVisible();
});
it("preserves selected climbs in the combined view on refresh", () => {
  const { rerender } = renderStrengths(<ClimbingStrengths data={fixture} />);
  fireEvent.click(screen.getByRole("button", { name: /Vertical · All grades/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Evening Arete",
  );
  rerender(<ClimbingStrengths data={structuredClone(fixture)} />);
  expect(screen.getByRole("button", { name: /Vertical · All grades/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Evening Arete",
  );
});
it("selects the hold-type breakdown", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  renderStrengths(
    <ClimbingStrengths
      data={{
        ...fixture,
        panels: [
          angle,
          {
            ...angle,
            key: "holds",
            dimension: "hold_type",
            rows: [{ key: "crimp", label: "Crimp", cells: angle.rows[0]?.cells ?? [] }],
            allGrades: {
              ...angle.allGrades,
              rows: [{ key: "crimp", label: "Crimp", cells: angle.allGrades.rows[0]?.cells ?? [] }],
            },
          },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  for (const disclosure of screen.queryAllByText("Exact values")) {
    if (!disclosure.closest("details")?.open) fireEvent.click(disclosure);
  }
  expect(screen.getByRole("button", { name: /Crimp · All grades/ })).toBeVisible();
});

it("selects missing dimensions and shows their empty state while preserving navigation", () => {
  const panel = fixture.panels[0];
  if (!panel) throw new Error("Missing fixture");
  renderStrengths(<ClimbingStrengths data={{ ...fixture, panels: [panel] }} />);
  for (const label of ["Hold type"]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText(`No recorded ${label.toLowerCase()} observations for this context.`),
    ).toBeVisible();
  }
  fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
  for (const disclosure of screen.queryAllByText("Exact values")) {
    if (!disclosure.closest("details")?.open) fireEvent.click(disclosure);
  }
  expect(screen.getByRole("button", { name: /Vertical · All grades/ })).toBeVisible();
});

it("keeps unknown source results visible in the selected style", () => {
  renderStrengths(<ClimbingStrengths data={climbingStrengthsUnknownResultsFixture} />);
  fireEvent.click(screen.getByRole("button", { name: /Vertical · All grades/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "2 sends / 9 climbs · 6 results unknown",
  );
  expect(screen.getByText(/V3 · .* · Result unknown/)).toBeVisible();
  expect(screen.getByText("Success rates use climbs with known results.")).toBeVisible();
});

it("shows the server grade-adjusted radar summary and keeps all styles after selection", () => {
  render(<ClimbingStrengths data={fixture} />);
  expect(screen.getByText("Strengths and weaknesses")).toBeVisible();
  fireEvent.click(screen.getByText("Exact values"));
  fireEvent.click(screen.getByRole("button", { name: /Vertical · All grades/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "13 sends / 21 climbs",
  );
  expect(screen.getByRole("button", { name: /Overhang · All grades/ })).toBeVisible();
});
it("keeps the monthly chart available across both breakdowns", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  render(
    <ClimbingStrengths
      data={{ ...fixture, panels: [angle, { ...angle, key: "holds", dimension: "hold_type" }] }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));
  expect(screen.getByText("Monthly send rate")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  fireEvent.click(screen.getByText("Exact values"));
  fireEvent.click(screen.getByRole("button", { name: /Vertical · All grades · 2026-10-01/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Evening Arete",
  );
});
