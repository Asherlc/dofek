import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ClimbingStrengths } from "./ClimbingStrengths";
import {
  climbingStrengthsComparisonFixture,
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
  fireEvent.click(screen.getByRole("button", { name: "View Strengths and weaknesses data" }));
}

it("keeps source-climb selection after a refreshed response and opens its source and activity", async () => {
  const result = render(<ClimbingStrengths data={climbingStrengthsComparisonFixture} />);
  openData();
  fireEvent.click(screen.getByRole("button", { name: /^0° · All grades:/ }));
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
  fireEvent.click(screen.getByRole("button", { name: /^Slab · All grades:/ }));
  expect(screen.getByText("No examples available for this selection.")).toBeTruthy();
  expect(screen.getByText("29% · 2 sends / 7 climbs")).toBeTruthy();
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
  expect(screen.getByRole("button", { name: /^Crimps · All grades:/ })).toBeTruthy();
});
it("separates initial loading, empty, error and cached refresh states", () => {
  const result = render(<ClimbingStrengths data={undefined} loading />);
  expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  result.rerender(
    <ClimbingStrengths data={data} loading error={{ message: "Reconnect provider" }} />,
  );
  expect(screen.getByText("Reconnect provider")).toBeTruthy();
  openData();
  expect(screen.getByRole("button", { name: /^Slab · All grades:/ })).toBeTruthy();
  result.rerender(<ClimbingStrengths data={{ ...data, panels: [] }} />);
  expect(screen.getByText("No recorded climbing outcomes in this period")).toBeTruthy();
});
it("keeps recorded unknown results in the selected style's source climbs", () => {
  render(<ClimbingStrengths data={climbingStrengthsUnknownResultsFixture} />);
  openData();
  fireEvent.click(screen.getByRole("button", { name: /^Vertical · All grades:/ }));
  expect(screen.getByText(/V3 · .* · Result unknown/)).toBeTruthy();
  expect(screen.getByText("Known ascent")).toBeTruthy();
  expect(screen.getByText("Success rates use climbs with known results.")).toBeTruthy();
});
it("uses styles and progress views for both breakdowns", () => {
  render(<ClimbingStrengths data={data} />);
  fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
  openData();
  expect(screen.getByRole("button", { name: /^Crimps · All grades:/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));
  expect(screen.getByText("Monthly send rate")).toBeTruthy();
  expect(screen.getByText(/Combines all grades/)).toBeTruthy();
});
