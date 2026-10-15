// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
import { UnattachedClimbingLogEntries } from "./UnattachedClimbingLogEntries";

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
