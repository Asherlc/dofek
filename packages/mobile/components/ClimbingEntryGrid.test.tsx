import { fireEvent, render, screen, within } from "@testing-library/react";
import { View } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { ClimbingEntryGrid } from "./ClimbingEntryGrid";
import { climbingEntryFixture, exactClimbingLocation } from "./climbing-entry-fixtures";

describe("ClimbingEntryGrid", () => {
  it("identifies the selected repeated card by full entry order including a locationless entry", () => {
    render(
      <ClimbingEntryGrid
        entries={[
          climbingEntryFixture,
          { ...climbingEntryFixture, id: "indoor", routeName: "Indoor" },
          { ...climbingEntryFixture, id: "repeat" },
        ]}
        locations={{ "tick-1": exactClimbingLocation, repeat: exactClimbingLocation }}
        selectedEntryId="repeat"
      />,
    );
    const cards = screen.getAllByLabelText(/Climbing entry:/);
    expect(cards[0]?.textContent).toContain("Entry 1");
    expect(cards[1]?.textContent).toContain("Entry 2");
    expect(cards[2]?.textContent).toContain("Entry 3 · Selected");
  });
  it("preserves source order and repeated ticks at one point", () => {
    render(
      <ClimbingEntryGrid
        entries={[
          { ...climbingEntryFixture, id: "second", routeName: "First occurrence" },
          climbingEntryFixture,
        ]}
        locations={{ second: exactClimbingLocation, "tick-1": exactClimbingLocation }}
      />,
    );
    const cards = screen.getAllByLabelText(/Climbing entry:/);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute("aria-label")).toBe("Climbing entry: First occurrence");
    expect(cards[1]?.getAttribute("aria-label")).toBe("Climbing entry: Swiss Cheese");
    expect(screen.getAllByText("Climb location: Swiss Cheese · Mountain Project")).toHaveLength(2);
  });

  it("allows a 280px cell basis to shrink inside the 256px padded screen content", () => {
    render(
      <View style={{ width: 320, padding: 16 }}>
        <View style={{ padding: 16 }}>
          <ClimbingEntryGrid
            entries={[
              {
                ...climbingEntryFixture,
                routeName: "Long route name across the entire California coastal climbing area",
              },
            ]}
            onAttach={vi.fn()}
          />
        </View>
      </View>,
    );
    const card = screen.getByLabelText(
      "Climbing entry: Long route name across the entire California coastal climbing area",
    );
    expect(card.parentElement?.style.flexShrink).toBe("1");
    expect(
      within(card)
        .getByRole("button", { name: "Attach to this activity" })
        .getAttribute("disabled"),
    ).toBeNull();
  });

  it("retains long names and source links while each Attach state remains independent", () => {
    const name =
      "A very long route name across the upper wall above the California coastal climbing area";
    const onAttach = vi.fn();
    render(
      <ClimbingEntryGrid
        entries={[
          { ...climbingEntryFixture, routeName: name },
          { ...climbingEntryFixture, id: "tick-2", routeName: "Second route" },
        ]}
        attachmentStates={{
          "tick-1": { pending: true, error: null },
          "tick-2": { pending: false, error: "Choose a climbing activity." },
        }}
        onAttach={onAttach}
      />,
    );
    expect(screen.getByRole("link", { name: `${name} on Mountain Project` })).toBeTruthy();
    const cards = screen.getAllByLabelText(/Climbing entry:/);
    const first = cards[0];
    const second = cards[1];
    if (!first || !second) throw new Error("Expected two tick cards");
    const firstControl = within(first).getByRole("button", { name: "Attach to this activity" });
    expect(firstControl.getAttribute("disabled")).not.toBeNull();
    expect(within(first).getByText("Attaching...")).toBeTruthy();
    expect(within(first).queryByText("Choose a climbing activity.")).toBeNull();
    expect(within(second).getByText("Choose a climbing activity.")).toBeTruthy();
    fireEvent.click(within(second).getByRole("button", { name: "Attach to this activity" }));
    expect(onAttach).toHaveBeenCalledWith("tick-2");
  });
});
