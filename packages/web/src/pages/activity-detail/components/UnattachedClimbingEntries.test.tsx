/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClimbingEntrySuggestion } from "../../../../../server/src/repositories/climbing-entry-associator.ts";
import { UnattachedClimbingEntries } from "./UnattachedClimbingEntries.tsx";

const suggestions: ClimbingEntrySuggestion[] = [
  {
    id: "entry-1",
    providerId: "openbeta",
    sourceName: null,
    climbType: "route",
    gradeSystem: "yds",
    grade: "5.10a",
    sent: false,
    ascentType: "Onsight",
    attemptCount: null,
    lead: true,
    routeName: null,
    locationName: "Test Crag",
  },
  {
    id: "entry-2",
    providerId: "mountain-project",
    sourceName: "Mountain Project",
    climbType: "boulder",
    gradeSystem: "v_scale",
    grade: "V4",
    sent: true,
    ascentType: null,
    attemptCount: 1,
    lead: null,
    routeName: "Blue Arete",
    locationName: null,
  },
];
const emptySuggestions: ClimbingEntrySuggestion[] = [];

describe("UnattachedClimbingEntries", () => {
  it("renders provider fallbacks, attachment states, and attaches the selected entry", () => {
    const onAttach = vi.fn();

    render(
      <UnattachedClimbingEntries
        suggestions={suggestions}
        error={null}
        isLoading={false}
        state={{
          "entry-1": { pending: true, error: "This entry is no longer available." },
        }}
        onAttach={onAttach}
      />,
    );

    expect(screen.getByText("Route")).toBeInTheDocument();
    expect(screen.getByText("OpenBeta")).toBeInTheDocument();
    expect(screen.getByText(/5\.10a · Attempted · Test Crag/)).toBeInTheDocument();
    expect(screen.getByText("Onsight")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("This entry is no longer available.");
    const buttons = screen.getAllByRole("button", { name: "Attach to this activity" });
    expect(buttons[0]).toBeDisabled();
    expect(screen.getByText("Attaching...")).toBeInTheDocument();
    const secondButton = buttons.at(1);
    if (!secondButton) throw new Error("Expected a second attach button");
    fireEvent.click(secondButton);
    expect(onAttach).toHaveBeenCalledWith("entry-2");
    expect(screen.getByText("Blue Arete")).toBeInTheDocument();
    expect(screen.getByText("Mountain Project")).toBeInTheDocument();
    expect(screen.getByText("V4 · Sent · 1 attempt")).toBeInTheDocument();
  });

  it.each([
    [
      "loading",
      { suggestions: undefined, error: null, isLoading: true },
      "Loading climbing entries...",
    ],
    [
      "empty",
      { suggestions: emptySuggestions, error: null, isLoading: false },
      "No unattached climbing entries for this day.",
    ],
    [
      "error",
      {
        suggestions: undefined,
        error: new Error("Could not load climbing entries"),
        isLoading: false,
      },
      "Could not load climbing entries",
    ],
  ] as const)("renders the %s state", (_label, props, message) => {
    render(<UnattachedClimbingEntries {...props} state={{}} onAttach={vi.fn()} />);

    expect(screen.getByText(message)).toBeInTheDocument();
  });
});
