import type { ClimbingStrengthsPanel } from "@dofek/training/climbing-strengths";
import { climbingStrengthsGradePanel } from "@dofek/training/climbing-strengths";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart";
import {
  climbingStrengthsComparisonFixture,
  climbingStrengthsFixture,
  climbingStrengthsUnknownResultsFixture,
} from "./climbing-strengths-fixtures";

const panel = climbingStrengthsFixture.panels[0];
if (!panel) throw new Error("Missing panel fixture");
const firstRow = panel.rows[0];
const secondRow = panel.rows[1];
const firstCell = firstRow?.cells[0];
if (!firstRow || !secondRow || !firstCell) throw new Error("Missing row fixture");

describe("ClimbingStrengthsChart", () => {
  it("labels every style curve when All grades remains selected", () => {
    render(
      <ClimbingStrengthsChart panel={panel} view="curves" grade="All grades" onSelect={() => {}} />,
    );
    for (const row of panel.rows) expect(screen.getByText(row.label)).toBeTruthy();
  });
  it("identifies the overall baseline in pooled exact values", () => {
    render(
      <ClimbingStrengthsChart
        panel={climbingStrengthsGradePanel(panel, "All grades")}
        view="gaps"
        grade="All grades"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^View .* data$/ }));
    expect(screen.getByLabelText(/Slab · All grades.*Overall baseline 36%/)).toBeTruthy();
  });
  it.each(["gaps", "curves", "exposure", "pyramids", "progress", "radar"] as const)(
    "%s retains exact supplied rates and counts, missing values and limited qualifiers",
    (view) => {
      render(<ClimbingStrengthsChart panel={panel} view={view} grade="V4" onSelect={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /^View .* data$/ }));
      expect(screen.getByLabelText(/Slab · V4.*0%.*0 sends \/ 2 climbs/)).toBeTruthy();
      if (view !== "progress") {
        expect(screen.getByLabelText(/Vertical · V3.*No data.*0 sends \/ 0 climbs/)).toBeTruthy();
      }
    },
  );
  it.each(["gaps", "exposure"] as const)("%s identifies the gap axis unit in full", (view) => {
    const rendered = render(
      <ClimbingStrengthsChart panel={panel} view={view} grade="V4" onSelect={() => {}} />,
    );
    expect(screen.getByText("Gap (percentage points)")).toBeTruthy();
    expect(
      rendered.container.querySelector('[role="image"]')?.getAttribute("aria-label"),
    ).toContain("percentage points");
  });
  it("draws observed and baseline radar polygons only with enough observed axes", () => {
    const comparison = climbingStrengthsComparisonFixture.panels[0];
    if (!comparison) throw new Error("Missing comparison fixture");
    const rendered = render(
      <ClimbingStrengthsChart panel={comparison} view="radar" grade="V3" onSelect={() => {}} />,
    );
    expect(rendered.container.querySelectorAll("Polygon")).toHaveLength(4);
    expect(rendered.container.querySelectorAll("Polygon[stroke-dasharray]")).toHaveLength(1);
    rendered.rerender(
      <ClimbingStrengthsChart panel={comparison} view="radar" grade="V4" onSelect={() => {}} />,
    );
    expect(
      screen.getByText(
        "Radar needs at least three styles with recorded success rates for this grade.",
      ),
    ).toBeTruthy();
  });
  it("facets progress by style and centers grade pyramids from harder to easier grades", () => {
    const rendered = render(
      <ClimbingStrengthsChart panel={panel} view="progress" grade="V4" onSelect={() => {}} />,
    );
    expect(
      rendered.container.querySelectorAll('G[accessibilityLabel="Slab progress"]'),
    ).toHaveLength(1);
    expect(
      rendered.container.querySelectorAll('G[accessibilityLabel="Vertical progress"]'),
    ).toHaveLength(1);
    rendered.rerender(
      <ClimbingStrengthsChart panel={panel} view="pyramids" grade="V3" onSelect={() => {}} />,
    );
    const slab = rendered.container.querySelector('G[accessibilityLabel="Slab grade pyramid"]');
    expect(slab).toBeTruthy();
    const labels = Array.from(slab?.querySelectorAll("SvgText") ?? []).map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["Slab", "V4", "V3"]);
    const tracks = Array.from(slab?.querySelectorAll("Rect") ?? []);
    const centers = tracks.map(
      (node) => Number(node.getAttribute("x")) + Number(node.getAttribute("width")) / 2,
    );
    expect(new Set(centers).size).toBe(1);
  });
  it("keeps zero progress markers and leaves missing months unconnected", () => {
    const rendered = render(
      <ClimbingStrengthsChart panel={panel} view="progress" grade="V4" onSelect={() => {}} />,
    );
    expect(rendered.container.querySelectorAll("Circle")).toHaveLength(2);
    expect(rendered.container.querySelectorAll("Line")).toHaveLength(6);
  });
  it("explains insufficient radar axes while retaining exact values", () => {
    render(<ClimbingStrengthsChart panel={panel} view="radar" grade="V4" onSelect={() => {}} />);
    expect(
      screen.getByText(
        "Radar needs at least three styles with recorded success rates for this grade.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View Radar profile data" }));
    expect(screen.getByLabelText(/Slab · V4.*0%/)).toBeTruthy();
  });
  it("uses supplied gap, baseline and counts without deriving metrics", () => {
    const supplied: ClimbingStrengthsPanel = {
      ...panel,
      rows: [
        {
          ...firstRow,
          cells: [
            {
              ...firstCell,
              unknownOutcomes: 0,
              sends: 7,
              climbs: 11,
              successRate: 17,
              differencePercentagePoints: -9,
            },
          ],
        },
      ],
    };
    render(
      <ClimbingStrengthsChart panel={supplied} view="pyramids" grade="V3" onSelect={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View Grade pyramids data" }));
    expect(
      screen.getByLabelText(
        /Slab · V3.*17%.*7 sends \/ 11 climbs.*baseline 44%.*-9 percentage points/,
      ),
    ).toBeTruthy();
  });
  it("keeps missing months as gaps and displays supplied zero months", () => {
    render(<ClimbingStrengthsChart panel={panel} view="progress" grade="V4" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "View Progress data" }));
    expect(screen.getByLabelText(/2026-08-15–2026-08-31 · Slab · V4.*No data/)).toBeTruthy();
    expect(
      screen.getByLabelText(/2026-10-01–2026-10-26 · Slab · V4.*0%.*0 sends \/ 2 climbs/),
    ).toBeTruthy();
  });
  it("renders all dense groups and a single grade/month without invalid SVG geometry", () => {
    const dense = {
      ...panel,
      grades: panel.grades.slice(1),
      rows: Array.from({ length: 20 }, (_, i) => ({
        key: `style-${i}`,
        label: `Style ${i}`,
        cells: secondRow.cells.slice(1),
      })),
      progress: panel.progress.slice(-1).map((month) => {
        const monthlyRow = month.rows.find((row) => row.key === secondRow.key);
        if (!monthlyRow) throw new Error("Missing monthly fixture row");
        return {
          ...month,
          rows: Array.from({ length: 20 }, (_, index) => ({
            ...monthlyRow,
            key: `style-${index}`,
            cells: monthlyRow.cells.slice(1),
          })),
        };
      }),
    };
    for (const view of ["gaps", "curves", "exposure", "pyramids", "progress", "radar"] as const) {
      const result = render(
        <ClimbingStrengthsChart panel={dense} view={view} grade="V4" onSelect={() => {}} />,
      );
      expect(result.container.innerHTML).not.toMatch(/NaN|Infinity/);
      if (view === "progress") {
        const points = result.container.querySelectorAll("Circle");
        expect(points).toHaveLength(20);
        expect(points[0]?.getAttribute("cx")).toBe("157");
        expect(Number(points[0]?.getAttribute("cy"))).toBeCloseTo(110.4);
      }
      fireEvent.click(screen.getByRole("button", { name: /^View .* data$/ }));
      expect(screen.getByLabelText(/Style 19 · V4.*33%.*1 sends \/ 3 climbs/)).toBeTruthy();
      result.unmount();
    }
  });
});

it.each(["gaps", "curves", "exposure", "pyramids", "progress", "radar"] as const)(
  "%s exposes unknown-result counts in exact values",
  (view) => {
    const unknownPanel = climbingStrengthsUnknownResultsFixture.panels[0];
    if (!unknownPanel) throw new Error("Missing unknown results fixture");
    render(
      <ClimbingStrengthsChart panel={unknownPanel} view={view} grade="V3" onSelect={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^View .* data$/ }));
    expect(
      screen.getByLabelText(
        /Vertical · V3.*Result unknown.*0 sends \/ 4 climbs · 4 results unknown/,
      ),
    ).toBeTruthy();
  },
);

it.each(["gaps", "pyramids"] as const)(
  "%s labels unknown-result climbs inside the visible plot",
  (view) => {
    const unknownPanel = climbingStrengthsUnknownResultsFixture.panels[0];
    if (!unknownPanel) throw new Error("Missing unknown results fixture");
    const rendered = render(
      <ClimbingStrengthsChart panel={unknownPanel} view={view} grade="V3" onSelect={() => {}} />,
    );
    const plotLabels = Array.from(rendered.container.querySelectorAll("SvgText")).map(
      (label) => label.textContent,
    );
    expect(plotLabels).toContain("Result unknown");
  },
);
