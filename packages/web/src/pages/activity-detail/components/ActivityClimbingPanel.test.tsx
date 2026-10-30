// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { maps, resetMaps } from "../../../lib/maplibre-test-helpers.ts";
import { ActivityClimbingPanel } from "./ActivityClimbingPanel.tsx";
import { climbingMapLocations, climbingMapLogs } from "./climbing-log-map-test-helpers.ts";

vi.mock(
  "maplibre-gl",
  async () => (await import("../../../lib/maplibre-test-helpers.ts")).maplibreMock,
);
beforeEach(resetMaps);

it("synchronizes row hover/focus, selection and repeated map choices without resetting the map", async () => {
  const open = vi.fn();
  render(
    <ActivityClimbingPanel
      entries={climbingMapLogs}
      locations={climbingMapLocations}
      onOpenEntry={open}
    />,
  );
  const dot = await screen.findByRole("button", { name: /^2 climbs · Swiss Cheese/ });
  const first = screen.getByRole("button", { name: "Select entry 1, Swiss Cheese" });
  const repeat = screen.getByRole("button", { name: "Select entry 4, Swiss Cheese" });
  const row = first.closest("li");
  if (!row) throw new Error("Expected climb row");
  fireEvent.mouseEnter(row);
  expect(dot).toHaveAttribute("data-highlighted", "true");
  fireEvent.mouseLeave(row);
  expect(dot).toHaveAttribute("data-highlighted", "false");
  fireEvent.focus(repeat);
  expect(dot).toHaveAttribute("data-highlighted", "true");
  const repeatRow = repeat.closest("li");
  if (!repeatRow) throw new Error("Expected repeat row");
  fireEvent.click(repeatRow);
  expect(repeat).toHaveAttribute("aria-pressed", "true");
  expect(dot).toHaveAttribute("aria-pressed", "true");
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(dot);
  expect(first).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(repeat);
  expect(first).toHaveAttribute("aria-pressed", "false");
  expect(repeat).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Log details for entry 1, Swiss Cheese" }));
  expect(open).toHaveBeenCalledWith("tick-1");
  await waitFor(() => expect(maps).toHaveLength(1));
  expect(maps[0]?.fitBounds).toHaveBeenCalledOnce();
});

it("retains unlocated entries and honest source scope in a single map layout", async () => {
  render(<ActivityClimbingPanel entries={climbingMapLogs} locations={climbingMapLocations} />);
  expect(screen.getByRole("heading", { name: "Wall" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "Other climbs" })).toBeVisible();
  await screen.findByRole("button", { name: /Area location: Goat Rock · OpenBeta/ });
  expect(screen.getByText("No recorded location")).toBeVisible();
  const indoor = screen.getByRole("button", { name: "Select entry 3, Indoor board log" });
  fireEvent.click(indoor);
  expect(indoor).toHaveAttribute("aria-pressed", "true");
  expect(screen.getAllByRole("region", { name: "Climbing locations" })).toHaveLength(1);
  await screen.findByRole("button", { name: /^2 climbs · Swiss Cheese/ });
});

it("includes unattached suggestions on the shared map even with no attached logs and preserves attachment errors", async () => {
  const onAttach = vi.fn();
  const suggestion = climbingMapLogs[0];
  if (!suggestion) throw new Error("Expected suggestion");
  render(
    <ActivityClimbingPanel
      entries={[]}
      suggestions={[suggestion]}
      locations={climbingMapLocations}
      attachmentStates={{
        [suggestion.id]: { pending: false, error: "Refresh this activity and try again." },
      }}
      onAttach={onAttach}
    />,
  );
  const dot = await screen.findByRole("button", { name: /^Swiss Cheese · Climb location/ });
  fireEvent.click(dot);
  expect(screen.getByRole("button", { name: "Select entry 1, Swiss Cheese" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Refresh this activity and try again.");
  fireEvent.click(
    screen.getByRole("button", { name: "Attach entry 1, Swiss Cheese to this activity" }),
  );
  expect(onAttach).toHaveBeenCalledWith(suggestion.id);
});

it("keeps the focused climb highlighted when the pointer leaves its row", async () => {
  render(<ActivityClimbingPanel entries={climbingMapLogs} locations={climbingMapLocations} />);
  const dot = await screen.findByRole("button", { name: /^2 climbs · Swiss Cheese/ });
  const control = screen.getByRole("button", { name: "Select entry 1, Swiss Cheese" });
  const row = control.closest("li");
  if (!row) throw new Error("Expected row");
  fireEvent.focus(control);
  fireEvent.mouseEnter(row);
  fireEvent.mouseLeave(row);
  expect(dot).toHaveAttribute("data-highlighted", "true");
  fireEvent.blur(control);
  expect(dot).toHaveAttribute("data-highlighted", "false");
});
