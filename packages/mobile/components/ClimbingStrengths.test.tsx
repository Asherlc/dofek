import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
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
function openData() {
  fireEvent.click(screen.getByRole("button", { name: "Grades" }));
}

it("shows all grades together and opens recorded climbs from accessible chart data", () => {
  render(<ClimbingStrengths data={data} />);
  openData();
  fireEvent.click(screen.getByRole("button", { name: /Slab · V3 · 40%/ }));
  expect(screen.getByText("Quiet Feet")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Slab · V4 · 0%/ })).toBeTruthy();
});
it("keeps source-climb selection after a refreshed response and opens its source and activity", async () => {
  const result = render(<ClimbingStrengths data={data} />);
  openData();
  fireEvent.click(screen.getByRole("button", { name: /Slab · V3 · 40%/ }));
  result.rerender(<ClimbingStrengths data={structuredClone(data)} />);
  expect(screen.getByText("Quiet Feet")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Mountain Project source for Quiet Feet" }));
  expect(openExternalUrl).toHaveBeenCalledWith(
    "https://www.mountainproject.com/route/1",
    "climbing-strengths-source",
  );
  fireEvent.click(screen.getByRole("button", { name: "View activity for Quiet Feet" }));
  expect(push).toHaveBeenCalledWith("/activity/activity-1");
});
it("keeps zero, missing observations and empty source examples distinct", () => {
  render(<ClimbingStrengths data={data} />);
  openData();
  expect(screen.getByRole("button", { name: /Vertical · V3 · No data/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Slab · V4 · 0%/ }));
  expect(screen.getByText("No examples available for this selection.")).toBeTruthy();
  expect(screen.getByText("0% · 0 sends / 2 climbs")).toBeTruthy();
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
  expect(screen.getByText("No recorded wall angle observations in this context.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  openData();
  expect(screen.getByRole("button", { name: /Crimps · V3/ })).toBeTruthy();
});
it("separates initial loading, empty, error and cached refresh states", () => {
  const result = render(<ClimbingStrengths data={undefined} loading />);
  expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  result.rerender(
    <ClimbingStrengths data={data} loading error={{ message: "Reconnect provider" }} />,
  );
  expect(screen.getByText("Reconnect provider")).toBeTruthy();
  openData();
  expect(screen.getByRole("button", { name: /Slab · V3/ })).toBeTruthy();
  result.rerender(<ClimbingStrengths data={{ ...data, panels: [] }} />);
  expect(screen.getByText("No recorded climbing outcomes in this period")).toBeTruthy();
});
it("keeps recorded unknown results available for selection at every grade", () => {
  render(<ClimbingStrengths data={climbingStrengthsUnknownResultsFixture} />);
  openData();
  fireEvent.click(screen.getByRole("button", { name: /Vertical · V3 · Result unknown/ }));
  expect(screen.getByText(/V3 · .* · Result unknown/)).toBeTruthy();
  expect(screen.getByRole("button", { name: /Vertical · V4 · 67%/ })).toBeTruthy();
  expect(screen.getByText("Success rates use climbs with known results.")).toBeTruthy();
});
it("uses fixed grade and progress views for both breakdowns", () => {
  render(<ClimbingStrengths data={data} />);
  fireEvent.click(screen.getByRole("button", { name: "Grades" }));
  fireEvent.click(screen.getByRole("button", { name: /Slab · V3 · 40%/ }));
  expect(screen.getByText("Quiet Feet")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  expect(screen.getByRole("button", { name: /Crimps · V4/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));
  expect(screen.getByText("Monthly send rate")).toBeTruthy();
  expect(screen.getByText(/Combines all grades/)).toBeTruthy();
});

it("selects source categories independently across Styles, Grades and Progress", async () => {
  const { climbingStrengthsTagsFixture: tagged } = await import("./climbing-strengths-fixtures");
  render(<ClimbingStrengths data={tagged} />);
  const category = screen.getByRole("button", { name: "Kaya · Movement" });
  fireEvent.click(category);
  expect(category.getAttribute("aria-selected")).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: /View .* data/ }));
  expect(screen.getAllByText(/Custom movement/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Grades" }));
  expect(screen.getAllByRole("button", { name: /Custom movement .* · V3/ }).length).toBeGreaterThan(
    0,
  );
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));

  expect(screen.getAllByText(/Custom movement/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "custom-source · Movement" }));
  fireEvent.click(screen.getByRole("button", { name: /View .* data/ }));
  expect(screen.getAllByText(/Other movement/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Kaya · Session mood" }));
  fireEvent.click(screen.getByRole("button", { name: /View .* data/ }));
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
