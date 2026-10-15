// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
import { climbingLogFixture, exactClimbingLocation } from "./climbing-log-entry-fixtures";
import { UnattachedClimbingLogEntries } from "./UnattachedClimbingLogEntries";

it("keeps repeated suggested logs numbered in one grid with independent attachment states and maps", () => {
  const onAttach = vi.fn();
  render(
    <UnattachedClimbingLogEntries
      suggestions={[climbingLogFixture, { ...climbingLogFixture, id: "repeat" }]}
      error={null}
      isLoading={false}
      locations={{ "tick-1": exactClimbingLocation, repeat: exactClimbingLocation }}
      selectedEntryId="repeat"
      state={{
        "tick-1": { pending: true, error: null },
        repeat: { pending: false, error: "Choose a climbing activity." },
      }}
      onAttach={onAttach}
    />,
  );
  const cards = screen.getAllByLabelText("Climbing entry: Swiss Cheese");
  const first = cards[0];
  const repeat = cards[1];
  if (!first || !repeat) throw new Error("Expected repeated log cards");
  expect(within(repeat).getByText("Entry 2 · Selected")).toBeTruthy();
  expect(
    within(first).getByRole("button", { name: "Attach to this activity" }).getAttribute("disabled"),
  ).not.toBeNull();
  expect(within(first).queryByText("Choose a climbing activity.")).toBeNull();
  expect(within(repeat).getByText("Climb location: Swiss Cheese · Mountain Project")).toBeTruthy();
  fireEvent.click(within(repeat).getByRole("button", { name: "Attach to this activity" }));
  expect(onAttach).toHaveBeenCalledWith("repeat");
});

it("preserves cached suggestions and a specific refresh error while attaching the selected log", () => {
  const entry = climbingLogEntryFixture({ climb: climbingClimbFixture() });
  const onAttach = vi.fn();
  render(
    <UnattachedClimbingLogEntries
      suggestions={[entry]}
      error={new Error("Source is unavailable. Retry the sync.")}
      isLoading={false}
      state={{}}
      onAttach={onAttach}
    />,
  );
  expect(screen.getByText("Corner")).toBeTruthy();
  expect(screen.getByText("Source is unavailable. Retry the sync.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Attach to this activity" }));
  expect(onAttach).toHaveBeenCalledWith(entry.id);
});
it("displays a pending attachment with its server error", () => {
  const entry = climbingLogEntryFixture({ climb: climbingClimbFixture() });
  render(
    <UnattachedClimbingLogEntries
      suggestions={[entry]}
      error={null}
      isLoading={false}
      state={{ [entry.id]: { pending: true, error: "This log belongs to a different day." } }}
      onAttach={vi.fn()}
    />,
  );
  expect(screen.getByText("Attaching...")).toBeTruthy();
  expect(screen.getByText("This log belongs to a different day.")).toBeTruthy();
});
it.each([
  [undefined, null, true, "Loading climbing logs..."],
  [[], null, false, "No unattached climbing logs for this day."],
  [undefined, new Error("Refresh the source connection."), false, "Refresh the source connection."],
] as const)(
  "renders an explicit loading, empty, or error state",
  (suggestions, error, isLoading, message) => {
    render(
      <UnattachedClimbingLogEntries
        suggestions={suggestions}
        error={error}
        isLoading={isLoading}
        state={{}}
        onAttach={vi.fn()}
      />,
    );
    expect(screen.getByText(message)).toBeTruthy();
  },
);
