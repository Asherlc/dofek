/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ClimbingStrengths } from "./ClimbingStrengths.tsx";
import { climbingStrengthsFixture as fixture } from "./climbing-strengths-fixtures.ts";

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
  fireEvent.click(screen.getByText("Coverage"));
  expect(
    screen.getByText(/2 unknown outcomes · 1 records excluded for missing or conflicting grades/),
  ).toBeVisible();
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
  fireEvent.change(screen.getByLabelText("Climbing context"), { target: { value: "route" } });
  expect(screen.getByText("Routes · Lead · YDS", { selector: "p" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Vertical · V4/ }));
  expect(screen.getByRole("region", { name: "Selected climbs" })).toHaveTextContent(
    "Evening Arete",
  );
  rerender(<ClimbingStrengths data={structuredClone(data)} />);
  expect(screen.getByLabelText("Climbing context")).toHaveValue("route");
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
  expect(screen.getByText(/Outdoor · Sends per distinct climb/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByRole("button", { name: /Crimp · V4/ })).toBeVisible();
  expect(screen.queryByLabelText("Strength setting")).toBeNull();
});
