/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { RadarComponentOption } from "echarts";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClimbingStrengthsChart } from "./ClimbingStrengthsChart.tsx";
import {
  climbingStrengthsUnknownResultsFixture,
  climbingStrengthsFixture as fixture,
} from "./climbing-strengths-fixtures.ts";
import type { DofekChart } from "./DofekChart.tsx";

const captured = vi.hoisted<{ props: ComponentProps<typeof DofekChart> | null }>(() => ({
  props: null,
}));
vi.mock("./DofekChart.tsx", () => ({
  DofekChart: (props: ComponentProps<typeof DofekChart>) => {
    captured.props = props;
    return (
      <>
        <div>Chart canvas</div>
        {props.dataDisclosure}
      </>
    );
  },
}));
afterEach(cleanup);
const panel = fixture.panels[0];
if (!panel) throw new Error("Missing fixture");
it.each(["curves", "pyramids"] as const)(
  "keeps the per-grade baseline heading for %s when All grades was selected",
  (view) => {
    render(
      <ClimbingStrengthsChart
        panel={panel}
        view={view}
        grade="All grades"
        selectedRow={null}
        onSelectCell={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Exact values"));
    expect(screen.getByRole("columnheader", { name: "Gap vs same-grade baseline" })).toBeVisible();
  },
);
it("spells out percentage-point units for positive, negative and recorded zero gaps", () => {
  const { rerender } = render(
    <ClimbingStrengthsChart
      panel={panel}
      view="gaps"
      grade="V4"
      selectedRow={null}
      onSelectCell={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("Exact values"));
  expect(screen.getByRole("cell", { name: "+12.5 percentage points" })).toBeVisible();
  expect(screen.getByRole("cell", { name: "-37.5 percentage points" })).toBeVisible();
  rerender(
    <ClimbingStrengthsChart
      panel={panel}
      view="gaps"
      grade="V3"
      selectedRow={null}
      onSelectCell={vi.fn()}
    />,
  );
  expect(screen.getByRole("cell", { name: "0 percentage points" })).toBeVisible();
});
it("exposes every curve baseline's supplied exact rate and sample without climb-selection buttons", () => {
  const onSelectCell = vi.fn();
  render(
    <ClimbingStrengthsChart
      panel={panel}
      view="curves"
      grade="V4"
      selectedRow={null}
      onSelectCell={onSelectCell}
    />,
  );
  fireEvent.click(screen.getByText("Exact values"));
  const baselineRows = screen.getAllByRole("rowheader", { name: /Same-grade baseline · V/ });
  expect(baselineRows).toHaveLength(4);
  const v4 = screen.getByRole("rowheader", { name: "Same-grade baseline · V4" }).closest("tr");
  if (!v4) throw new Error("Missing baseline row");
  expect(within(v4).getByText("37.5% · 3 sends / 8 climbs")).toBeVisible();
  expect(within(v4).queryByRole("button")).toBeNull();
  captured.props?.onEvents?.click?.({
    data: { name: "Same-grade baseline", grade: "V4", value: 37.5 },
  });
  expect(onSelectCell).not.toHaveBeenCalled();
});
it("includes the selected radar baseline in exact values even when the polygon is sparse", () => {
  render(
    <ClimbingStrengthsChart
      panel={panel}
      view="radar"
      grade="V4"
      selectedRow={null}
      onSelectCell={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("Exact values"));
  expect(screen.getAllByRole("rowheader", { name: /Same-grade baseline/ })).toHaveLength(1);
  const baseline = screen
    .getByRole("rowheader", { name: "Same-grade baseline · V4" })
    .closest("tr");
  if (!baseline) throw new Error("Missing baseline row");
  expect(within(baseline).getByText("37.5% · 3 sends / 8 climbs")).toBeVisible();
});
it("explains sparse radar without hiding exact values or selection", () => {
  const onSelectCell = vi.fn();
  render(
    <ClimbingStrengthsChart
      panel={panel}
      view="radar"
      grade="V4"
      selectedRow={null}
      onSelectCell={onSelectCell}
    />,
  );
  expect(screen.getByText(/Radar needs at least three style groups/)).toBeVisible();
  expect(screen.queryByText("Chart canvas")).toBeNull();
  fireEvent.click(screen.getByText("Exact values"));
  fireEvent.click(screen.getByRole("button", { name: /Overhang · V4 · 0% · 0 sends \/ 2 climbs/ }));
  expect(onSelectCell).toHaveBeenCalledWith("overhang", "V4");
});
it("uses data-scoped monthly dates and resolves chart clicks to whole-period detail keys", () => {
  const onSelectCell = vi.fn();
  render(
    <ClimbingStrengthsChart
      panel={panel}
      view="progress"
      grade="V4"
      selectedRow="vertical"
      onSelectCell={onSelectCell}
    />,
  );
  expect(captured.props?.timeRangeMode).toBe("data");
  expect(screen.getByText(/Each climb counts once in each month/)).toBeVisible();
  captured.props?.onEvents?.click?.({ data: { rowKey: "vertical", grade: "V4" } });
  expect(onSelectCell).toHaveBeenCalledWith("vertical", "V4");
  captured.props?.onEvents?.click?.({ data: { rowKey: "nonexistent", grade: "V4" } });
  expect(onSelectCell).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText("Exact values"));
  expect(
    screen.getByRole("button", {
      name: /Vertical · V4 · 2026-08-15 – 2026-08-31 · 0% · 0 sends \/ 1 climb/,
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: /Vertical · V4 · 2026-09-01 – 2026-09-30 · No data/ }),
  ).toBeVisible();
});
it("retains dense styles and complete long labels in keyboard-selectable exact values", () => {
  const dense = {
    ...panel,
    rows: Array.from({ length: 24 }, (_, index) => ({
      ...panel.rows[0],
      key: `row-${index}`,
      label: `Long source wall-angle description ${index}`,
      cells: panel.rows[0]?.cells ?? [],
    })),
  };
  render(
    <ClimbingStrengthsChart
      panel={dense}
      view="gaps"
      grade="V3"
      selectedRow={null}
      onSelectCell={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("Exact values"));
  expect(screen.getAllByRole("button")).toHaveLength(24);
  expect(
    screen.getByRole("button", { name: /Long source wall-angle description 23 · V3 · 80%/ }),
  ).toBeVisible();
});

it.each(["gaps", "curves", "exposure", "pyramids", "progress", "radar"] as const)(
  "%s exposes unknown-result counts in exact values",
  (view) => {
    const unknownPanel = climbingStrengthsUnknownResultsFixture.panels[0];
    if (!unknownPanel) throw new Error("Missing unknown results fixture");
    render(
      <ClimbingStrengthsChart
        panel={unknownPanel}
        view={view}
        grade="V3"
        selectedRow={null}
        onSelectCell={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Exact values"));
    expect(
      screen.getByRole("button", {
        name: /Vertical · V3.*Result unknown · 0 sends \/ 4 climbs · 4 results unknown/,
      }),
    ).toBeVisible();
  },
);

it("labels limited adjusted scores and keeps their table columns aligned", () => {
  const pooled = {
    ...panel,
    ...panel.allGrades,
    gradeAdjustedStrengths: panel.gradeAdjustedStrengths.map((entry) => ({
      ...entry,
      sampleStatus: "limited" as const,
    })),
  };
  render(
    <ClimbingStrengthsChart
      panel={pooled}
      view="radar"
      grade="All grades"
      selectedRow={null}
      onSelectCell={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText("Exact values"));
  const point = screen.getByRole("button", { name: /Vertical · All grades.*Limited sample/ });
  const row = point.closest("tr");
  if (!row) throw new Error("Missing row");
  expect(within(row).getAllByRole("cell")).toHaveLength(1);
  expect(screen.getAllByRole("columnheader")).toHaveLength(2);
});
it("opens a radar style's climbs from its axis label without treating the baseline as a style", () => {
  const pooled = { ...panel, ...panel.allGrades };
  const onSelectCell = vi.fn();
  render(
    <ClimbingStrengthsChart
      panel={pooled}
      view="radar"
      grade="All grades"
      selectedRow={null}
      onSelectCell={onSelectCell}
    />,
  );
  captured.props?.onEvents?.click?.({
    componentType: "radar",
    targetType: "axisName",
    name: "Overhang",
  });
  expect(onSelectCell).toHaveBeenCalledWith("overhang", "All grades");
  captured.props?.onEvents?.click?.({
    componentType: "radar",
    targetType: "axisName",
    name: "Unknown",
  });
  captured.props?.onEvents?.click?.({ data: { name: "Same-grade baseline", value: [0, 0, 0] } });
  expect(onSelectCell).toHaveBeenCalledTimes(1);
});

it.each(["V3", "All grades"])("keeps duplicate-label radar tag cohorts distinct at %s", (grade) => {
  const source = grade === "All grades" ? { ...panel, ...panel.allGrades } : panel;
  const duplicateTags = {
    ...source,
    dimension: "tag" as const,
    category: { providerId: "source", key: "grips", label: "Grip" },
    rows: source.rows.map((row, index) => ({ ...row, label: index < 2 ? "Crimp" : "Sloper" })),
  };
  const onSelectCell = vi.fn();
  render(
    <ClimbingStrengthsChart
      panel={duplicateTags}
      view="radar"
      grade={grade}
      selectedRow={null}
      onSelectCell={onSelectCell}
    />,
  );
  const radarSchema = z.object({
    indicator: z.array(z.object({ name: z.string() })),
    axisName: z.object({
      formatter: z.custom<(name?: string) => string>((value) => typeof value === "function"),
    }),
  }) satisfies z.ZodType<RadarComponentOption>;
  const radar = radarSchema.parse(captured.props?.option.radar);
  const secondAxis = radar.indicator?.[1];
  if (!secondAxis) throw new Error("Missing second radar axis");
  captured.props?.onEvents?.click?.({
    componentType: "radar",
    targetType: "axisName",
    name: radar.axisName.formatter(secondAxis.name),
  });
  expect(onSelectCell).toHaveBeenCalledWith("overhang", grade);
  const firstAxis = radar.indicator?.[0];
  if (!firstAxis) throw new Error("Missing first radar axis");
  captured.props?.onEvents?.click?.({
    componentType: "radar",
    targetType: "axisName",
    name: radar.axisName.formatter(firstAxis.name),
  });
  expect(onSelectCell).toHaveBeenLastCalledWith("vertical", grade);
});
