// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useImperativeHandle } from "react";
import * as Native from "react-native";
import { expect, it, vi } from "vitest";

vi.mock(
  "@maplibre/maplibre-react-native",
  async () => (await import("./native-map-test-helpers")).nativeMapMock,
);

import { ActivityClimbingPanel } from "./ActivityClimbingPanel";
import { climbingLogFixture, exactClimbingLocation } from "./climbing-log-entry-fixtures";

it("lists explicitly linked Kaya and Kilter locations under one area heading", () => {
  const climb = climbingLogFixture.climb;
  const area = climb?.areaPath[0];
  if (!climb || !area) throw new Error("Expected climbing fixture");
  const entries = ["Touchstone Great Western Power Company", "Great Western Power Company"].map(
    (name, index) => ({
      ...climbingLogFixture,
      id: `log-${index}`,
      providerId: index === 0 ? "kaya" : "kilter",
      sourceName: index === 0 ? "Kaya" : "Kilter Board",
      climb: { ...climb, name: `Problem ${index + 1}` },
      areaGroupId: "30000000-0000-4000-8000-000000000001",
      areaPath: [{ ...area, id: `gym-${index}`, name }],
    }),
  );
  render(<ActivityClimbingPanel entries={entries} locations={{}} />);
  expect(screen.getAllByRole("header", { name: /^Area:/ })).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Select entry 1, Problem 1" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Select entry 2, Problem 2" })).toBeDefined();
});

it("scrolls the climb list to the selected row using its measured position", () => {
  const scrollTo = vi.fn();
  const scrollView = vi
    .spyOn(Native, "ScrollView")
    .mockImplementation(({ children, ref, onLayout, accessibilityLabel }) => {
      useImperativeHandle<unknown, { scrollTo: typeof scrollTo }>(ref, () => ({ scrollTo }));
      return (
        <Native.View accessibilityLabel={accessibilityLabel} onLayout={onLayout}>
          {children}
        </Native.View>
      );
    });
  try {
    const entries = [climbingLogFixture, { ...climbingLogFixture, id: "repeat" }];
    const view = render(
      <ActivityClimbingPanel entries={entries} locations={{}} selectedEntryId={null} />,
    );
    const row = screen.getByLabelText("Climb list").lastElementChild;
    if (!row) throw new Error("Expected row");
    fireEvent(
      screen.getByLabelText("Climb list"),
      new CustomEvent("layout", { detail: { height: 560 } }),
    );
    fireEvent(row, new CustomEvent("layout", { detail: { y: 720, height: 140 } }));
    view.rerender(
      <ActivityClimbingPanel entries={entries} locations={{}} selectedEntryId="repeat" />,
    );
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 300, animated: false });
    scrollTo.mockClear();
    // A fresh map or row selection must reveal the same occurrence again.
    fireEvent.click(screen.getByRole("button", { name: "Select entry 2, Swiss Cheese" }));
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 300, animated: false });
    scrollTo.mockClear();
    fireEvent(row, new CustomEvent("layout", { detail: { y: 100, height: 140 } }));
    expect(scrollTo).not.toHaveBeenCalled();
    view.rerender(
      <ActivityClimbingPanel
        entries={entries}
        locations={{}}
        selectedEntryId={climbingLogFixture.id}
      />,
    );
    view.rerender(
      <ActivityClimbingPanel entries={entries} locations={{}} selectedEntryId="repeat" />,
    );
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent(row, new CustomEvent("layout", { detail: { y: 900, height: 140 } }));
    expect(scrollTo).not.toHaveBeenCalled();
    view.unmount();
  } finally {
    scrollView.mockRestore();
  }
});

it("renders chart selections and sends subsequent row selections to the shared owner", () => {
  const onSelectEntry = vi.fn();
  const entries = [climbingLogFixture, { ...climbingLogFixture, id: "repeat" }];
  const view = render(
    <ActivityClimbingPanel
      entries={entries}
      locations={{}}
      selectedEntryId={null}
      onSelectEntry={onSelectEntry}
    />,
  );
  view.rerender(
    <ActivityClimbingPanel
      entries={entries}
      locations={{}}
      selectedEntryId="repeat"
      onSelectEntry={onSelectEntry}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Select entry 2, Swiss Cheese" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Select entry 1, Swiss Cheese" }));
  expect(onSelectEntry).toHaveBeenLastCalledWith(climbingLogFixture.id);
});

it("selects each repeated occurrence from list and map and keeps details explicit", () => {
  const onOpenEntry = vi.fn();
  const onSelectEntry = vi.fn();
  const entries = [climbingLogFixture, { ...climbingLogFixture, id: "repeat" }];
  const { container } = render(
    <ActivityClimbingPanel
      entries={entries}
      locations={{ [climbingLogFixture.id]: exactClimbingLocation, repeat: exactClimbingLocation }}
      onOpenEntry={onOpenEntry}
      onSelectEntry={onSelectEntry}
    />,
  );
  const repeat = screen.getByRole("button", { name: "Select entry 2, Swiss Cheese" });
  fireEvent.click(repeat);
  expect(repeat.getAttribute("aria-selected")).toBe("true");
  expect(onSelectEntry).toHaveBeenLastCalledWith("repeat");
  expect(onOpenEntry).not.toHaveBeenCalled();
  const mapWrapper = container.querySelector("[data-testid=climbing-map]");
  if (!mapWrapper) throw new Error("Expected shared map");
  fireEvent(mapWrapper, new CustomEvent("layout", { detail: { width: 320, height: 280 } }));
  const marker = screen.getByLabelText(/2 climbs · Swiss Cheese/);
  fireEvent.click(marker);
  expect(onSelectEntry).toHaveBeenLastCalledWith(climbingLogFixture.id);
  onSelectEntry.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Select entry 1, Swiss Cheese" }));
  expect(onSelectEntry).toHaveBeenCalledWith(climbingLogFixture.id);
  expect(
    screen
      .getByRole("button", { name: "Select entry 1, Swiss Cheese" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Log details for entry 2, Swiss Cheese" }));
  expect(onOpenEntry).toHaveBeenCalledWith("repeat");
});

it("keeps entries without GPS selectable", () => {
  const entries = [
    climbingLogFixture,
    { ...climbingLogFixture, id: "indoor", climb: null, title: "Indoor" },
  ];
  render(
    <ActivityClimbingPanel
      entries={entries}
      locations={{
        [climbingLogFixture.id]: {
          ...exactClimbingLocation,
          scope: "area",
          name: "Goat Rock",
          providerId: "openbeta",
        },
      }}
    />,
  );
  expect(screen.getByText("No recorded location")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select entry 2, Indoor" }));
  expect(
    screen.getByRole("button", { name: "Select entry 2, Indoor" }).getAttribute("aria-selected"),
  ).toBe("true");
});

it("renders the complete recorded area path in a horizontal heading and preserves missing areas", () => {
  const climb = climbingLogFixture.climb;
  const baseArea = climb?.areaPath[0];
  if (!climb || !baseArea) throw new Error("Expected a climb fixture");
  const areaPath = [
    { ...baseArea, id: "california", name: "California", parentAreaId: null },
    {
      ...baseArea,
      id: "sf-bay",
      name: "San Francisco Bay Area",
      parentAreaId: "california",
    },
    { ...baseArea, id: "east-bay", name: "East Bay Area", parentAreaId: "sf-bay" },
    { ...baseArea, id: "berkeley", name: "Berkeley", parentAreaId: "east-bay" },
    {
      ...baseArea,
      id: "grizzly-peak",
      name: "Grizzly Peak Boulders",
      parentAreaId: "berkeley",
    },
    {
      ...baseArea,
      id: "main-rock",
      name: "Main Rock (aka Scary Boulder)",
      parentAreaId: "grizzly-peak",
    },
  ];
  const fullPath =
    "California › San Francisco Bay Area › East Bay Area › Berkeley › Grizzly Peak Boulders › Main Rock (aka Scary Boulder)";
  render(
    <ActivityClimbingPanel
      entries={[
        { ...climbingLogFixture, climb: { ...climb, areaPath } },
        { ...climbingLogFixture, id: "indoor", climb: null, title: "Indoor" },
      ]}
      locations={{}}
    />,
  );
  const heading = screen.getByRole("header", { name: `Area: ${fullPath}` });
  expect(heading.textContent).toBe(fullPath);
  expect(screen.getByRole("header", { name: "Other climbs" })).toBeTruthy();
});

it("maps unattached suggestions and retains their independent Attach state", () => {
  const onAttach = vi.fn();
  const { container } = render(
    <ActivityClimbingPanel
      entries={[]}
      suggestions={[climbingLogFixture]}
      locations={{ [climbingLogFixture.id]: exactClimbingLocation }}
      attachmentStates={{
        [climbingLogFixture.id]: { pending: false, error: "Refresh this activity and try again." },
      }}
      onAttach={onAttach}
    />,
  );
  const mapWrapper = container.querySelector("[data-testid=climbing-map]");
  if (!mapWrapper) throw new Error("Expected shared map");
  fireEvent(mapWrapper, new CustomEvent("layout", { detail: { width: 320, height: 280 } }));
  fireEvent.click(screen.getByLabelText("Swiss Cheese"));
  expect(
    screen
      .getByRole("button", { name: "Select entry 1, Swiss Cheese" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("alert").textContent).toBe("Refresh this activity and try again.");
  fireEvent.click(
    screen.getByRole("button", { name: "Attach entry 1, Swiss Cheese to this activity" }),
  );
  expect(onAttach).toHaveBeenCalledWith(climbingLogFixture.id);
});
