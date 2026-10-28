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
it("names the grade heatmap for assistive technology", () => {
  render(<ClimbingStrengths data={fixture} />);
  fireEvent.click(screen.getByRole("button", { name: "Grades" }));
  expect(screen.getByRole("table", { name: "Success by grade and wall angle" })).toBeVisible();
});
function renderStrengths(element: Parameters<typeof render>[0]) {
  const result = render(element);
  const grades = screen.queryByRole("button", { name: "Grades" });
  if (grades) fireEvent.click(grades);
  for (const disclosure of screen.queryAllByText("Exact values")) fireEvent.click(disclosure);
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
it("distinguishes zero and missing data and exposes actual examples", () => {
  renderStrengths(<ClimbingStrengths data={fixture} />);
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
  const { rerender } = renderStrengths(<ClimbingStrengths data={undefined} loading />);
  expect(screen.getByLabelText("Loading climbing strengths.")).toBeVisible();
  rerender(<ClimbingStrengths data={fixture} loading />);
  fireEvent.click(screen.getByRole("button", { name: "Grades" }));
  expect(screen.getByRole("button", { name: /Vertical · V4/ })).toBeVisible();
  rerender(<ClimbingStrengths data={{ panels: [], coverage: fixture.coverage }} />);
  expect(screen.getByText("No recorded climbing strengths in this period.")).toBeVisible();
});
it("preserves selected climbs in the combined view on refresh", () => {
  const { rerender } = renderStrengths(<ClimbingStrengths data={fixture} />);
  fireEvent.click(screen.getByRole("button", { name: /Vertical · V4/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Evening Arete",
  );
  rerender(<ClimbingStrengths data={structuredClone(fixture)} />);
  expect(screen.getByRole("button", { name: /Vertical · V4/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Evening Arete",
  );
});
it("selects hold types without mixing observations from different settings", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  renderStrengths(
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
  for (const disclosure of screen.queryAllByText("Exact values")) fireEvent.click(disclosure);
  expect(screen.getByRole("button", { name: /Crimp · V4/ })).toBeVisible();
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
  for (const disclosure of screen.queryAllByText("Exact values")) fireEvent.click(disclosure);
  expect(screen.getByRole("button", { name: /Vertical · V4/ })).toBeVisible();
});

it("shows unknown results and mixed counts without treating logged climbs as missing", () => {
  renderStrengths(<ClimbingStrengths data={climbingStrengthsUnknownResultsFixture} />);
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
it("uses a fixed heatmap and monthly chart for Grades and Progress across both breakdowns", () => {
  const angle = fixture.panels[0];
  if (!angle) throw new Error("Missing fixture");
  render(
    <ClimbingStrengths
      data={{ ...fixture, panels: [angle, { ...angle, key: "holds", dimension: "hold_type" }] }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Grades" }));
  expect(screen.getByRole("columnheader", { name: "V3" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Vertical · V4/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Evening Arete",
  );
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByRole("columnheader", { name: "V4" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));
  expect(screen.getByText("Monthly send rate")).toBeVisible();
  expect(screen.getByText(/Combines all grades/)).toBeVisible();
});

it("selects source categories independently across Styles, Grades and Progress", async () => {
  const { climbingStrengthsTagsFixture: tagged } = await import("./climbing-strengths-fixtures");
  render(<ClimbingStrengths data={tagged} />);
  const category = screen.getByRole("button", { name: "Kaya · Movement" });
  fireEvent.click(category);
  expect(category.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByText("Exact values"));
  expect(screen.getAllByText(/Custom movement/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Grades" }));
  expect(screen.getAllByRole("button", { name: /Custom movement .* · V3/ }).length).toBeGreaterThan(
    0,
  );
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));
  fireEvent.click(screen.getByText("Exact values"));
  expect(screen.getAllByText(/Custom movement/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "custom-source · Movement" }));
  expect(screen.getAllByText(/Other movement/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Kaya · Session mood" }));
  expect(screen.getAllByText(/Unfamiliar/).length).toBeGreaterThan(0);
});
it("prefers observed tags when wall and hold observations are missing", async () => {
  const { climbingStrengthsTagsFixture: tagged } = await import("./climbing-strengths-fixtures");
  render(
    <ClimbingStrengths
      data={{ ...tagged, panels: tagged.panels.map((panel) => ({ ...panel, rows: [] })) }}
    />,
  );
  expect(screen.getByRole("button", { name: "Kaya · Movement" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
});
