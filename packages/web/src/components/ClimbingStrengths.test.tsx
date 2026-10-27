/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

it("defaults single-grade views to pooled All grades and filters supplied results on selection", () => {
  render(<ClimbingStrengths data={fixture} />);
  fireEvent.change(screen.getByLabelText("View"), { target: { value: "gaps" } });
  expect(screen.getByLabelText("Grade")).toHaveValue("All grades");
  fireEvent.click(screen.getByText("Exact values"));
  fireEvent.click(screen.getByRole("button", { name: /Vertical · All grades · 62%/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "13 sends / 21 climbs",
  );
  fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "V4" } });
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "3 sends / 6 climbs",
  );
  fireEvent.change(screen.getByLabelText("Grade"), { target: { value: "All grades" } });
  fireEvent.change(screen.getByLabelText("View"), { target: { value: "profile" } });
  expect(screen.getByRole("columnheader", { name: "V4" })).toBeVisible();
  fireEvent.change(screen.getByLabelText("View"), { target: { value: "radar" } });
  expect(screen.getByLabelText("Grade")).toHaveValue("All grades");
});

it("offers seven views and retains selected source details through refreshes", () => {
  const { rerender } = render(<ClimbingStrengths data={fixture} />);
  expect(screen.getByLabelText("View")).toHaveValue("profile");
  for (const label of [
    "Grade profile",
    "Style gaps",
    "Success curves",
    "Exposure map",
    "Grade pyramids",
    "Progress",
    "Radar profile",
  ])
    expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Vertical · V4/ }));
  for (const view of ["gaps", "curves", "exposure", "pyramids", "progress", "radar", "profile"]) {
    fireEvent.change(screen.getByLabelText("View"), { target: { value: view } });
    if (!["profile", "curves", "pyramids"].includes(view))
      expect(screen.getByLabelText("Grade")).toHaveValue("V4");
    expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
      "Evening Arete",
    );
  }
  fireEvent.change(screen.getByLabelText("View"), { target: { value: "progress" } });
  rerender(<ClimbingStrengths data={structuredClone(fixture)} />);
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Across the selected period",
  );
  expect(screen.getByRole("link", { name: "KAYA" })).toHaveAttribute(
    "href",
    "https://kayaclimb.com/climb/example",
  );
});

afterEach(cleanup);
it("keeps grouping and view controls usable when the period has no panels", () => {
  render(<ClimbingStrengths data={{ ...fixture, panels: [] }} />);
  for (const name of ["Wall angle", "Hold type", "Indoor & outdoor"]) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  }
  fireEvent.change(screen.getByLabelText("View"), { target: { value: "curves" } });
  expect(screen.getByLabelText("View")).toHaveValue("curves");
  expect(screen.getByText("No recorded climbing strengths in this period.")).toBeVisible();
});
it.each(["wall_angle", "hold_type"] as const)(
  "labels a single %s panel when its setting is unknown",
  (dimension) => {
    const panel = fixture.panels[0];
    if (!panel) throw new Error("Missing fixture");
    render(
      <ClimbingStrengths
        data={{ ...fixture, panels: [{ ...panel, dimension, setting: "unknown" }] }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Setting unknown" })).toBeVisible();
  },
);
it("renders both pooled unknown-result examples with stable distinct identities", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    render(<ClimbingStrengths data={climbingStrengthsUnknownResultsFixture} />);
    fireEvent.change(screen.getByLabelText("View"), { target: { value: "gaps" } });
    fireEvent.click(screen.getByText("Exact values"));
    fireEvent.click(screen.getByRole("button", { name: /Vertical · All grades/ }));
    expect(screen.getByText("Unknown ascent")).toBeVisible();
    expect(screen.getByText("Known ascent")).toBeVisible();
    expect(error).not.toHaveBeenCalled();
  } finally {
    error.mockRestore();
  }
});
it("renders both recorded settings as separate labeled panels across dimensions", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  const outdoor = {
    ...angle,
    key: "outdoor",
    setting: "outdoor" as const,
    rows: angle.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) =>
        row.key === "vertical" && cell.grade === "V4"
          ? {
              ...cell,
              sends: 1,
              climbs: 2,
              successRate: 50,
              examples: cell.examples.map((example) => ({
                ...example,
                logEntryId: `outdoor-${example.logEntryId}`,
                name: `Outdoor ${example.name}`,
              })),
            }
          : cell,
      ),
    })),
  };
  render(
    <ClimbingStrengths
      data={{
        ...fixture,
        panels: [
          angle,
          outdoor,
          { ...angle, key: "holds", dimension: "hold_type" },
          { ...outdoor, key: "holds-outdoor", dimension: "hold_type" },
        ],
      }}
    />,
  );
  for (const dimension of ["Wall angle", "Hold type"]) {
    fireEvent.click(screen.getByRole("button", { name: dimension }));
    for (const [setting, counts, name] of [
      ["Indoor", "3 sends / 6 climbs", "Evening Arete"],
      ["Outdoor", "1 sends / 2 climbs", "Outdoor Evening Arete"],
    ] as const) {
      const panel = screen.getByRole("heading", { name: setting }).parentElement;
      if (!panel) throw new Error("Missing setting panel");
      const scope = within(panel);
      const cell = scope.getByRole("button", { name: /Vertical · V4/ });
      expect(cell).toHaveAccessibleName(expect.stringContaining(counts));
      fireEvent.click(cell);
      expect(scope.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(name);
    }
  }
});
it("distinguishes zero and missing data and exposes actual examples", () => {
  render(<ClimbingStrengths data={fixture} />);
  fireEvent.click(screen.getByRole("button", { name: /Vertical · V4/ }));
  expect(screen.getByRole("link", { name: "KAYA" }).getAttribute("href")).toBe(
    "https://kayaclimb.com/climb/example",
  );
  expect(screen.getByRole("link", { name: "View activity" }).getAttribute("href")).toBe(
    "/activity/activity-1",
  );
  expect(screen.getByText("Evening Arete")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Overhang · V4/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "0 sends / 2 climbs",
  );
  expect(screen.getByRole("button", { name: /Slab · V4 · No data/ })).toBeVisible();
});
it("keeps cached content during loading and distinguishes initial loading from empty", () => {
  const { rerender } = render(<ClimbingStrengths data={undefined} loading />);
  expect(screen.getByLabelText("Loading climbing strengths.")).toBeVisible();
  rerender(<ClimbingStrengths data={fixture} loading />);
  expect(screen.getByRole("button", { name: /Vertical · V4/ })).toBeVisible();
  rerender(<ClimbingStrengths data={{ panels: [], coverage: fixture.coverage }} />);
  expect(screen.getByText("No recorded climbing strengths in this period.")).toBeVisible();
});
it("renders each context separately and preserves its selected climbs on refresh", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  const setting = { ...angle, key: "setting", dimension: "setting" as const, setting: null };
  const data = {
    ...fixture,
    panels: [
      { ...angle, rows: [] },
      setting,
      { ...setting, key: "route", contextKey: "route", contextLabel: "Lead" },
    ],
  };
  const { rerender } = render(<ClimbingStrengths data={data} />);
  expect(screen.getByRole("button", { name: "Indoor & outdoor" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const route = within(screen.getByRole("region", { name: "Lead" }));
  fireEvent.click(route.getByRole("button", { name: /Vertical · V4/ }));
  expect(route.getByRole("region", { name: "Selected climbs" })).toHaveTextContent("Evening Arete");
  rerender(<ClimbingStrengths data={structuredClone(data)} />);
  expect(route.getByRole("button", { name: /Vertical · V4/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(route.getByRole("region", { name: "Selected climbs" })).toHaveTextContent("Evening Arete");
});
it("selects hold types without mixing observations from different settings", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  render(
    <ClimbingStrengths
      data={{
        ...fixture,
        panels: [
          angle,
          { ...angle, key: "outdoor", setting: "outdoor" },
          {
            ...angle,
            key: "holds",
            dimension: "hold_type",
            rows: [{ key: "crimp", label: "Crimp", cells: angle.rows[0]?.cells ?? [] }],
          },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByRole("button", { name: /Crimp · V4/ })).toBeVisible();
});

it("selects missing dimensions and shows their empty state while preserving navigation", () => {
  const panel = fixture.panels[0];
  if (!panel) throw new Error("Missing fixture");
  render(<ClimbingStrengths data={{ ...fixture, panels: [panel] }} />);
  for (const label of ["Hold type", "Indoor & outdoor"]) {
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(screen.getByRole("button", { name: label })).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText(`No recorded ${label.toLowerCase()} observations for this context.`),
    ).toBeVisible();
  }
  fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
  expect(screen.getByRole("button", { name: /Vertical · V4/ })).toBeVisible();
});

it("shows unknown results and mixed counts without treating logged climbs as missing", () => {
  render(<ClimbingStrengths data={climbingStrengthsUnknownResultsFixture} />);
  fireEvent.click(
    screen.getByRole("button", {
      name: /Vertical · V3 · Result unknown · 0 sends \/ 4 climbs · 4 results unknown/,
    }),
  );
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Result unknown",
  );
  expect(screen.getByText(/V3 · .* · Result unknown/)).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", {
      name: /Vertical · V4 · 67% · 2 sends \/ 5 climbs · 2 results unknown/,
    }),
  );
  expect(screen.getByText("Success rates use climbs with known results.")).toBeVisible();
});
