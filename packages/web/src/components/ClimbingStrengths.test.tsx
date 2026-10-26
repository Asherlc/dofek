/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ClimbingStrengths } from "./ClimbingStrengths.tsx";
import { climbingStrengthsFixture as fixture } from "./climbing-strengths-fixtures.ts";

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

it("offers seven views and retains context, setting, grade and source details through refreshes", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  const data = {
    ...fixture,
    panels: [
      angle,
      { ...angle, key: "outdoor", setting: "outdoor" as const },
      { ...angle, key: "route", contextKey: "route", contextLabel: "Routes" },
      {
        ...angle,
        key: "route-outdoor",
        contextKey: "route",
        contextLabel: "Routes",
        setting: "outdoor" as const,
      },
    ],
  };
  const { rerender } = render(<ClimbingStrengths data={data} />);
  expect(screen.getByLabelText("View")).toHaveValue("profile");
  expect(screen.queryByLabelText("Grade")).toBeNull();
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
  fireEvent.click(screen.getByRole("button", { name: /^Routes/ }));
  fireEvent.change(screen.getByLabelText("Strength setting"), {
    target: { value: "route-outdoor" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Vertical · V4/ }));
  for (const view of ["gaps", "curves", "exposure", "pyramids", "progress", "radar", "profile"]) {
    fireEvent.change(screen.getByLabelText("View"), { target: { value: view } });
    if (["profile", "curves", "pyramids"].includes(view)) {
      expect(screen.queryByLabelText("Grade")).toBeNull();
    } else {
      expect(screen.getByLabelText("Grade")).toHaveValue("V4");
    }
    expect(screen.getByRole("button", { name: /^Routes/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Strength setting")).toHaveValue("route-outdoor");
    expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
      "Evening Arete",
    );
  }
  fireEvent.change(screen.getByLabelText("View"), { target: { value: "progress" } });
  rerender(<ClimbingStrengths data={structuredClone(data)} />);
  expect(screen.getByLabelText("View")).toHaveValue("progress");
  expect(screen.getByLabelText("Grade")).toHaveValue("V4");
  expect(screen.getByRole("button", { name: /^Routes/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByLabelText("Strength setting")).toHaveValue("route-outdoor");
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Across the selected period",
  );
  expect(screen.getByRole("link", { name: "KAYA" })).toHaveAttribute(
    "href",
    "https://kayaclimb.com/climb/example",
  );
});

afterEach(cleanup);
it("preserves the actual setting between dimensions and through the setting comparison", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  const panels = [
    angle,
    { ...angle, key: "angle-outdoor", setting: "outdoor" as const },
    { ...angle, key: "holds-indoor", dimension: "hold_type" as const },
    {
      ...angle,
      key: "holds-outdoor",
      dimension: "hold_type" as const,
      setting: "outdoor" as const,
    },
    { ...angle, key: "setting", dimension: "setting" as const, setting: null },
  ];
  render(<ClimbingStrengths data={{ ...fixture, panels }} />);
  fireEvent.change(screen.getByLabelText("Strength setting"), {
    target: { value: "angle-outdoor" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Vertical · V4/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByLabelText("Strength setting")).toHaveValue("holds-outdoor");
  expect(screen.queryByRole("region", { name: "Selected climbs" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
  expect(screen.getByLabelText("Strength setting")).toHaveValue("angle-outdoor");
  fireEvent.click(screen.getByRole("button", { name: "Indoor & outdoor" }));
  expect(screen.queryByLabelText("Strength setting")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
  expect(screen.getByLabelText("Strength setting")).toHaveValue("angle-outdoor");
  fireEvent.change(screen.getByLabelText("Strength setting"), { target: { value: angle.key } });
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByLabelText("Strength setting")).toHaveValue("holds-indoor");
});
it("distinguishes zero, limited and missing data and exposes actual examples", () => {
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
  expect(screen.getByText(/0 sends \/ 2 climbs/)).toBeVisible();
  expect(screen.getAllByText("Limited data").length).toBeGreaterThan(0);
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
it("defaults to observations and preserves selection across refreshes and context changes", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  const setting = { ...angle, key: "setting", dimension: "setting" as const, setting: null };
  const data = {
    ...fixture,
    panels: [
      { ...angle, rows: [] },
      setting,
      { ...setting, key: "route", contextKey: "route", contextLabel: "Routes · Lead · YDS" },
    ],
  };
  const { rerender } = render(<ClimbingStrengths data={data} />);
  expect(screen.getByRole("button", { name: "Indoor & outdoor" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: /^Routes/ }));
  expect(screen.getByRole("button", { name: /^Routes/ })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: /Vertical · V4/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Evening Arete",
  );
  rerender(<ClimbingStrengths data={structuredClone(data)} />);
  expect(screen.getByRole("button", { name: /^Routes/ })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: /Vertical · V4/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Evening Arete",
  );
});
it("selects hold types and recorded settings without mixing their observations", () => {
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
  fireEvent.change(screen.getByLabelText("Strength setting"), { target: { value: "outdoor" } });
  expect(screen.getByLabelText("Strength setting")).toHaveValue("outdoor");
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByRole("button", { name: /Crimp · V4/ })).toBeVisible();
  expect(screen.queryByLabelText("Strength setting")).toBeNull();
});
