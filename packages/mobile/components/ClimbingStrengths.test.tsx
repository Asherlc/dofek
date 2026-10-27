import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClimbingStrengths } from "./ClimbingStrengths";
import {
  climbingStrengthsUnknownResultsFixture,
  climbingStrengthsFixture as fixture,
} from "./climbing-strengths-fixtures";

const data = {
  ...fixture,
  panels: fixture.panels.filter((panel) => panel.contextKey === "boulder-v"),
};
const openExternalUrl = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../lib/open-external-url", () => ({ openExternalUrl }));
const push = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
function renderAtV3(element: Parameters<typeof render>[0]) {
  const result = renderWithOptions(element);
  const grade = screen.queryByRole("button", { name: "V3" });
  if (grade) fireEvent.click(grade);
  return result;
}
function renderWithOptions(element: Parameters<typeof render>[0]) {
  const result = render(element);
  const grades = screen.queryByRole("button", { name: "Styles" });
  if (grades) fireEvent.click(grades);
  const options = screen.queryByRole("button", { name: "Chart options" });
  if (options) fireEvent.click(options);
  const pooled = screen.queryByRole("button", { name: "All grades" });
  if (pooled) fireEvent.click(pooled);
  return result;
}
describe("ClimbingStrengths", () => {
  it("defaults to an observed grade while preserving an explicitly selected empty grade", () => {
    const panels = data.panels.map((panel) => ({
      ...panel,
      rows: panel.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) =>
          cell.grade === "V3" ? { ...cell, sampleStatus: "no_data" as const } : cell,
        ),
      })),
    }));
    render(<ClimbingStrengths data={{ ...data, panels }} />);
    expect(screen.getByRole("button", { name: "V4" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "V3" }));
    fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
    expect(screen.getByRole("button", { name: "V3" }).getAttribute("aria-selected")).toBe("true");
  });
  it.each(["Success curves", "Grade pyramids"])(
    "keeps the pooled warning specific to pooled views when switching to %s",
    (view) => {
      renderWithOptions(<ClimbingStrengths data={data} />);
      const warning =
        "All grades combines different difficulties; comparisons are not grade-adjusted.";
      expect(screen.getByText(warning)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /^View:/ }));
      fireEvent.click(screen.getByRole("radio", { name: view }));
      expect(screen.queryByText(warning)).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Styles" }));
      expect(screen.getByText(warning)).toBeTruthy();
    },
  );
  it("shows all grade columns in Grades and opens the selected heatmap cell's source climbs", () => {
    render(<ClimbingStrengths data={data} />);
    fireEvent.click(screen.getByRole("button", { name: "Grades" }));
    fireEvent.click(screen.getByRole("button", { name: /^Slab · V3 · 40%/ }));
    expect(screen.getByRole("button", { name: /^Slab · V4 · 0%.*Limited sample$/ })).toBeTruthy();
    expect(screen.getByText("Quiet Feet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Slab · V4 · 0%/ }));
    expect(screen.getByText("No examples available for this selection.")).toBeTruthy();
  });
  it("opens Styles at an individual grade and preserves grade across purpose changes", () => {
    render(<ClimbingStrengths data={data} />);
    expect(screen.getByRole("button", { name: "Styles" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "V3" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Grades" }));
    fireEvent.click(screen.getByRole("button", { name: /^Slab · V4 · 0%/ }));
    fireEvent.click(screen.getByRole("button", { name: "Progress" }));
    expect(screen.getByRole("button", { name: "V4" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "All grades" }));
    expect(
      screen.getByText(
        "All grades combines different difficulties; comparisons are not grade-adjusted.",
      ),
    ).toBeTruthy();
  });
  it("keeps grouping and view controls usable when the period has no panels", () => {
    renderWithOptions(<ClimbingStrengths data={{ ...data, panels: [] }} />);
    for (const name of ["Wall angle", "Hold type"]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.getByRole("button", { name }).getAttribute("aria-selected")).toBe("true");
    }
    fireEvent.click(screen.getByRole("button", { name: /^View:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Success curves" }));
    expect(screen.getByRole("button", { name: "View: Success curves" })).toBeTruthy();
    expect(screen.getByText("No recorded climbing outcomes in this period")).toBeTruthy();
  });
  it.each(["wall_angle", "hold_type"] as const)(
    "labels a single %s panel when its setting is unknown",
    (dimension) => {
      const panel = data.panels[0];
      if (!panel) throw new Error("Missing fixture");
      renderWithOptions(
        <ClimbingStrengths
          data={{ ...data, panels: [{ ...panel, dimension, setting: "unknown" }] }}
        />,
      );
      expect(screen.getByText("Setting unknown").getAttribute("role")).toBe("header");
    },
  );
  it("renders both pooled unknown-result examples with stable distinct identities", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderWithOptions(<ClimbingStrengths data={climbingStrengthsUnknownResultsFixture} />);
      fireEvent.click(screen.getByRole("button", { name: /^Vertical · 67%/ }));
      expect(screen.getByText("Unknown ascent")).toBeTruthy();
      expect(screen.getByText("Known ascent")).toBeTruthy();
      expect(error.mock.calls.some(([message]) => String(message).includes("same key"))).toBe(
        false,
      );
    } finally {
      error.mockRestore();
    }
  });
  it("selects pooled All grades and switches to individual grade results", () => {
    renderWithOptions(<ClimbingStrengths data={data} />);
    expect(screen.getByRole("button", { name: "All grades" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("Overall baseline · 36% · 5 sends / 14 climbs")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Slab · 29%/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "V3" }));
    expect(screen.getByRole("button", { name: /^Slab · 40%/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All grades" }));
    expect(screen.getByRole("button", { name: /^Slab · 29%/ })).toBeTruthy();
  });
  it("changes visualization with a compact native radio picker and retains selected climbs on refresh", () => {
    const rendered = renderAtV3(<ClimbingStrengths data={data} />);
    fireEvent.click(screen.getByRole("button", { name: /^Slab · 40%/ }));
    for (const label of [
      "Style gaps",
      "Success curves",
      "Exposure map",
      "Grade pyramids",
      "Progress",
      "Radar profile",
      "Grade profile",
    ]) {
      fireEvent.click(screen.getByRole("button", { name: /^View:/ }));
      fireEvent.click(screen.getByRole("radio", { name: label }));
      expect(screen.queryByRole("radio")).toBeNull();
      expect(screen.getByRole("button", { name: `View: ${label}` })).toBeTruthy();
      expect(screen.getByText("Quiet Feet")).toBeTruthy();
      if (label === "Grade profile") expect(screen.getByText("V3")).toBeTruthy();
      else
        expect(screen.getByRole("button", { name: "V3" }).getAttribute("aria-selected")).toBe(
          "true",
        );
    }
    rendered.rerender(<ClimbingStrengths data={structuredClone(data)} loading />);
    expect(screen.getByText("Quiet Feet")).toBeTruthy();
  });
  it("labels progress examples as applying to the selected period", () => {
    renderAtV3(<ClimbingStrengths data={data} />);
    fireEvent.click(screen.getByRole("button", { name: /^Slab · 40%/ }));
    fireEvent.click(screen.getByRole("button", { name: /^View:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Progress" }));
    expect(screen.getByText("Recorded climbs · Across the selected period")).toBeTruthy();
  });
  it("hides chart-selected detail when its grade disappears during refresh", () => {
    const rendered = renderAtV3(<ClimbingStrengths data={data} />);
    fireEvent.click(screen.getByRole("button", { name: /^View:/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Success curves" }));
    const point = rendered.container.querySelector('Circle[accessibilityLabel^="Slab · V4"]');
    if (!point) throw new Error("Missing V4 curve point");
    fireEvent.click(point);
    expect(screen.getByRole("button", { name: "V4" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("No examples available for this selection.")).toBeTruthy();
    rendered.rerender(
      <ClimbingStrengths
        data={{
          ...data,
          panels: data.panels.map((panel) => ({
            ...panel,
            grades: panel.grades.filter((item) => item.grade !== "V4"),
            rows: panel.rows.map((row) => ({
              ...row,
              cells: row.cells.filter((cell) => cell.grade !== "V4"),
            })),
            progress: panel.progress.map((month) => ({
              ...month,
              rows: month.rows.map((row) => ({
                ...row,
                cells: row.cells.filter((cell) => cell.grade !== "V4"),
              })),
            })),
          })),
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "View: Success curves" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "V3" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Quiet Feet")).toBeNull();
    expect(screen.queryByText("Recorded climbs")).toBeNull();
    expect(screen.getByRole("button", { name: /^Slab · 40%/ }).getAttribute("aria-selected")).toBe(
      "false",
    );
  });
  it("keeps source details tied to their recorded setting panel", () => {
    const panel = data.panels[0];
    if (!panel) throw new Error("Missing fixture");
    const outdoor = {
      ...panel,
      key: "outdoor",
      setting: "outdoor" as const,
      rows: panel.rows.map((row) => ({
        ...row,
        cells: row.cells.map((cell) => ({
          ...cell,
          examples: cell.examples.map((example) => ({ ...example, name: "Outdoor Slab" })),
        })),
      })),
    };
    const rendered = renderAtV3(<ClimbingStrengths data={{ ...data, panels: [panel, outdoor] }} />);
    expect(screen.getByText("Indoor")).toBeTruthy();
    expect(screen.getByText("Outdoor")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /^Slab · 40%/ })[0]);
    expect(screen.getByText("Quiet Feet")).toBeTruthy();
    rendered.rerender(<ClimbingStrengths data={{ ...data, panels: [outdoor] }} />);
    expect(screen.queryByText("Recorded climbs")).toBeNull();
    expect(screen.getByRole("button", { name: "V3" }).getAttribute("aria-selected")).toBe("true");
  });
  it("renders server values and selects grade, dimension and context", () => {
    renderAtV3(<ClimbingStrengths data={data} />);
    expect(screen.getByText("Same-grade baseline · 44% · 4 sends / 9 climbs")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Slab · 40% · 2 sends / 5 climbs · -4 percentage points vs same-grade baseline",
      }),
    );
    expect(screen.getByText("Quiet Feet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View activity for Quiet Feet" }));
    expect(push).toHaveBeenCalledWith("/activity/activity-1");
    fireEvent.click(screen.getByRole("link", { name: "Mountain Project source for Quiet Feet" }));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://www.mountainproject.com/route/1",
      "climbing-strengths-source",
    );
    fireEvent.click(screen.getByRole("button", { name: "V4" }));
    expect(screen.getByText("Same-grade baseline · 20% · 1 send / 5 climbs")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Slab · 0% · 0 sends / 2 climbs · -20 percentage points vs same-grade baseline",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Vertical · 33% · 1 send / 3 climbs · +13 percentage points vs same-grade baseline",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
    expect(
      screen.getByRole("button", {
        name: "Crimps · 0% · 0 sends / 2 climbs · -20 percentage points vs same-grade baseline",
      }),
    ).toBeTruthy();
  });
  it("shows recorded indoor and outdoor panels across style breakdowns", () => {
    const angle = data.panels[0];
    const setting = data.panels.find((panel) => panel.dimension === "setting");
    if (!angle || !setting) throw new Error("Missing fixture");
    renderAtV3(
      <ClimbingStrengths
        data={{
          ...data,
          panels: [angle, { ...angle, key: "outdoor-angle", setting: "outdoor" }, setting],
        }}
      />,
    );
    expect(screen.getByText("Indoor")).toBeTruthy();
    expect(screen.getByText("Outdoor")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
    expect(screen.getByText("Indoor")).toBeTruthy();
    expect(screen.getByText("Outdoor")).toBeTruthy();
  });
  it("keeps unknown-only contexts visible beside recorded contexts", () => {
    const panels = fixture.panels.map((panel) =>
      panel.contextKey === "route-yds-lead"
        ? {
            ...panel,
            grades: [],
            rows: [],
            allGrades: { ...panel.allGrades, grades: [] },
            coverage: { missingTraits: 0, unknownOutcomes: 3 },
          }
        : panel,
    );
    renderAtV3(<ClimbingStrengths data={{ ...fixture, panels }} />);
    expect(screen.getByText("Bouldering · V scale · Free")).toBeTruthy();
    expect(screen.getByText("Routes · YDS · Lead · Free")).toBeTruthy();
    expect(screen.getByText("Same-grade baseline · 44% · 4 sends / 9 climbs")).toBeTruthy();
    expect(screen.getByText("No recorded wall angle observations in this context.")).toBeTruthy();
  });
  it("distinguishes no data", () => {
    renderAtV3(<ClimbingStrengths data={data} />);
    expect(screen.getByRole("button", { name: "Vertical · No data" })).toBeTruthy();
  });
  it("separates loading, errors, empty and cached refresh", () => {
    const view = renderAtV3(<ClimbingStrengths data={undefined} loading />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    view.rerender(
      <ClimbingStrengths data={undefined} error={{ message: "Reconnect your account." }} />,
    );
    expect(screen.getByText("Reconnect your account.")).toBeTruthy();
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
    view.rerender(<ClimbingStrengths data={{ panels: [], coverage: data.coverage }} />);
    expect(screen.getByText("No recorded climbing outcomes in this period")).toBeTruthy();
    view.rerender(
      <ClimbingStrengths data={data} loading error={{ message: "Reconnect your account." }} />,
    );
    expect(screen.getByText("Same-grade baseline · 44% · 4 sends / 9 climbs")).toBeTruthy();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
  });
});

it("selects missing dimensions and shows their empty state while preserving navigation", () => {
  const panel = data.panels[0];
  if (!panel) throw new Error("Missing fixture");
  renderWithOptions(<ClimbingStrengths data={{ ...data, panels: [panel] }} />);
  for (const label of ["Hold type"]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByRole("button", { name: label }).getAttribute("aria-selected")).toBe("true");
    expect(
      screen.getByText(`No recorded ${label.toLowerCase()} observations in this context.`),
    ).toBeTruthy();
  }
  fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
  expect(screen.getByRole("button", { name: /^Slab · 29%/ })).toBeTruthy();
});

it.each(["Success curves", "Grade pyramids"])(
  "%s shows every setting's grades even when the selected grade occurs in only one",
  (view) => {
    const original = data.panels[0];
    if (!original) throw new Error("Missing fixture");
    const panels = ["V3", "V4"].map((grade, index) => ({
      ...original,
      key: grade,
      setting: index === 0 ? ("indoor" as const) : ("outdoor" as const),
      grades: original.grades.filter((item) => item.grade === grade),
      rows: original.rows.map((row) => ({
        ...row,
        cells: row.cells.filter((cell) => cell.grade === grade),
      })),
    }));
    renderAtV3(<ClimbingStrengths data={{ ...data, panels }} />);
    fireEvent.click(screen.getByRole("button", { name: /^View:/ }));
    fireEvent.click(screen.getByRole("radio", { name: view }));
    expect(screen.getAllByRole("button", { name: `View ${view} data` })).toHaveLength(2);
    for (const button of screen.getAllByRole("button", { name: `View ${view} data` })) {
      fireEvent.click(button);
    }
    const [indoor, outdoor] = screen.getAllByRole("list");
    if (!indoor || !outdoor) throw new Error("Missing chart values");
    expect(within(indoor).getByText("Slab · V3")).toBeTruthy();
    expect(within(outdoor).getByText("Slab · V4")).toBeTruthy();
  },
);

it("uses an empty state for missing traits even when the panel has graded climbs", () => {
  const original = data.panels[0];
  if (!original) throw new Error("Missing fixture");
  renderWithOptions(
    <ClimbingStrengths
      data={{
        ...data,
        panels: [{ ...original, rows: [], allGrades: { ...original.allGrades, rows: [] } }],
      }}
    />,
  );
  expect(screen.getByText("No recorded wall angle observations in this context.")).toBeTruthy();
  expect(screen.queryByText(/Overall baseline/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /^View:/ }));
  fireEvent.click(screen.getByRole("radio", { name: "Success curves" }));
  expect(screen.getByText("No recorded wall angle observations in this context.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "View Success curves data" })).toBeNull();
});

it("shows unknown results and explains known-only rates for mixed climbs", () => {
  renderWithOptions(<ClimbingStrengths data={climbingStrengthsUnknownResultsFixture} />);
  fireEvent.click(screen.getByRole("button", { name: "V3" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: /Vertical · Result unknown · 0 sends \/ 4 climbs · 4 results unknown/,
    }),
  );
  expect(screen.getByText(/V3 · .* · Result unknown/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "V4" }));
  expect(
    screen.getByRole("button", {
      name: /Vertical · 67% · 2 sends \/ 5 climbs · 2 results unknown/,
    }),
  ).toBeTruthy();
  expect(screen.getByText("Success rates use climbs with known results.")).toBeTruthy();
});
