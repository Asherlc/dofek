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
    ascentType: null,
    attemptCount: null,
    lead: false,
    routeName: null,
    locationName: "Test Crag",
    context: {
      providerId: "openbeta",
      locationPath: [{ name: "Test Crag", externalId: null, kind: null }],
      board: null,
      wallAngle: null,
      climbStyle: "top-rope",
      resultStyle: "Fell/Hung",
    },
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
    context: {
      providerId: "mountain-project",
      locationPath: [],
      board: null,
      wallAngle: null,
      climbStyle: null,
      resultStyle: "Send",
    },
  },
];
const emptySuggestions: ClimbingEntrySuggestion[] = [];

describe("UnattachedClimbingEntries", () => {
  it.each(["Onsight", "Flash"] as const)(
    "shows the grade and %s badge as the complete result for a first-try tick",
    (ascentType) => {
      const suggestion = suggestions.at(1);
      if (!suggestion) throw new Error("Expected a climbing suggestion fixture");
      render(
        <UnattachedClimbingEntries
          suggestions={[
            {
              ...suggestion,
              climbType: "route",
              gradeSystem: "yds",
              grade: "5.6",
              routeName: "Left Arete",
              ascentType,
              attemptCount: null,
              context: { ...suggestion.context, climbStyle: "lead", resultStyle: ascentType },
            },
          ]}
          error={null}
          isLoading={false}
          state={{}}
          onAttach={vi.fn()}
        />,
      );
      expect(screen.getByText("Left Arete")).toBeInTheDocument();
      expect(screen.getByText("5.6", { exact: true })).toBeInTheDocument();
      expect(screen.getByText(ascentType)).toBeInTheDocument();
      expect(screen.queryByText(/attempt|\bSent\b/i)).not.toBeInTheDocument();
    },
  );

  it("shows a redpoint's attempts alongside its result badge", () => {
    const suggestion = suggestions.at(1);
    if (!suggestion) throw new Error("Expected a climbing suggestion fixture");
    render(
      <UnattachedClimbingEntries
        suggestions={[
          {
            ...suggestion,
            ascentType: "Redpoint",
            attemptCount: 7,
            context: { ...suggestion.context, resultStyle: "Redpoint" },
          },
        ]}
        error={null}
        isLoading={false}
        state={{}}
        onAttach={vi.fn()}
      />,
    );
    expect(screen.getByText("V4 · 7 attempts")).toBeInTheDocument();
    expect(screen.getByText("Redpoint")).toBeInTheDocument();
  });

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
    expect(screen.getByText(/5\.10a · Not sent; attempt count not recorded/)).toBeInTheDocument();
    expect(screen.getByText("Test Crag")).toBeInTheDocument();
    expect(screen.getByText("Top rope")).toBeInTheDocument();
    expect(screen.getByText("Fell or hung")).toBeInTheDocument();
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
    expect(screen.getByText("V4 · Sent in 1 attempt")).toBeInTheDocument();
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
