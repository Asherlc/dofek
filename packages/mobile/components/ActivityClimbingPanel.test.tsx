// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

vi.mock(
  "@maplibre/maplibre-react-native",
  async () => (await import("./native-map-test-helpers")).nativeMapMock,
);

import { ActivityClimbingPanel } from "./ActivityClimbingPanel";
import { climbingLogFixture, exactClimbingLocation } from "./climbing-log-entry-fixtures";

it("selects each repeated occurrence from list and map and keeps details explicit", () => {
  const onOpenEntry = vi.fn();
  const entries = [climbingLogFixture, { ...climbingLogFixture, id: "repeat" }];
  const { container } = render(
    <ActivityClimbingPanel
      entries={entries}
      locations={{ [climbingLogFixture.id]: exactClimbingLocation, repeat: exactClimbingLocation }}
      onOpenEntry={onOpenEntry}
    />,
  );
  const repeat = screen.getByRole("button", { name: "Select entry 2, Swiss Cheese" });
  fireEvent.click(repeat);
  expect(repeat.getAttribute("aria-selected")).toBe("true");
  expect(onOpenEntry).not.toHaveBeenCalled();
  const mapWrapper = container.querySelector("[data-testid=climbing-map]");
  if (!mapWrapper) throw new Error("Expected shared map");
  fireEvent(mapWrapper, new CustomEvent("layout", { detail: { width: 320, height: 280 } }));
  const marker = screen.getByLabelText(/2 climbs · Swiss Cheese/);
  fireEvent.click(marker);
  expect(
    screen
      .getByRole("button", { name: "Select entry 1, Swiss Cheese" })
      .getAttribute("aria-selected"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Log details for entry 2, Swiss Cheese" }));
  expect(onOpenEntry).toHaveBeenCalledWith("repeat");
});

it("keeps entries without GPS and identifies approximate area sources", () => {
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
  expect(screen.getByText("Approximate area location")).toBeTruthy();
  expect(screen.getByText("No recorded location")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Select entry 2, Indoor" }));
  expect(
    screen.getByRole("button", { name: "Select entry 2, Indoor" }).getAttribute("aria-selected"),
  ).toBe("true");
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
