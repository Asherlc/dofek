/** @vitest-environment jsdom */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ClimbingEntrySuggestion } from "../../../../../server/src/repositories/climbing-entry-associator.ts";
import { UnattachedClimbingEntries } from "./UnattachedClimbingEntries.tsx";

const suggestions: ClimbingEntrySuggestion[] = [
  {
    id: "entry-1",
    providerId: "openbeta",
    sourceName: null,
    sourceLinks: [],
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
    sourceLinks: [],
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
afterEach(() => vi.unstubAllGlobals());

beforeAll(() => {
  Object.defineProperty(SVGSVGElement.prototype, "createSVGRect", {
    configurable: true,
    value: () => ({}),
  });
});

describe("UnattachedClimbingEntries", () => {
  it("keeps a tick's map mounted when only its attachment state changes", async () => {
    let enterViewport = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          enterViewport = () => callback([{ isIntersecting: true }]);
        }
        observe() {}
        disconnect() {}
      },
    );
    const props = {
      suggestions,
      locations: {
        "entry-1": {
          coordinates: { latitude: 37.8, longitude: -122.4 },
          scope: "area" as const,
          objectId: "crag",
          providerId: "openbeta",
          name: "Test Crag",
        },
      },
      error: null,
      isLoading: false,
      onAttach: vi.fn(),
    };
    const { container, rerender } = render(<UnattachedClimbingEntries {...props} state={{}} />);
    await act(async () => {
      await import("leaflet");
    });
    expect(container.querySelector("img.leaflet-tile")).toBeNull();
    act(() => enterViewport());
    await waitFor(() => expect(container.querySelector("img.leaflet-tile")).not.toBeNull());
    const tile = container.querySelector("img.leaflet-tile");
    rerender(
      <UnattachedClimbingEntries
        {...props}
        state={{ "entry-1": { pending: true, error: null } }}
      />,
    );
    await waitFor(() => expect(container.querySelector("img.leaflet-tile")).toBe(tile));
    expect(screen.getByText("Attaching...")).toBeInTheDocument();
  });

  it("keeps ordered tick cards, source locations, and independent attachment actions", () => {
    const onAttach = vi.fn();
    render(
      <UnattachedClimbingEntries
        suggestions={suggestions}
        locations={{
          "entry-1": {
            coordinates: { latitude: 37.8, longitude: -122.4 },
            scope: "area",
            objectId: "area-1",
            providerId: "openbeta",
            name: "Test Crag",
          },
          "entry-2": {
            coordinates: { latitude: 37.8, longitude: -122.4 },
            scope: "climb",
            objectId: "climb-2",
            providerId: "mountain-project",
            name: "Blue Arete",
          },
        }}
        error={null}
        isLoading={false}
        state={{ "entry-1": { pending: true, error: "Entry unavailable" } }}
        onAttach={onAttach}
      />,
    );
    const cards = screen.getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent("Route");
    expect(cards[1]).toHaveTextContent("Blue Arete");
    expect(screen.getByText("Area location: Test Crag · OpenBeta")).toBeInTheDocument();
    expect(screen.getByText("Climb location: Blue Arete · Mountain Project")).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: /Climbing locations/ })).toHaveLength(2);
    const buttons = screen.getAllByRole("button", { name: "Attach to this activity" });
    expect(buttons[0]).toBeDisabled();
    expect(buttons[1]).toBeEnabled();
    const second = buttons[1];
    if (!second) throw new Error("Expected the second Attach action");
    fireEvent.click(second);
    expect(onAttach).toHaveBeenCalledWith("entry-2");
    expect(screen.getByRole("alert")).toHaveTextContent("Entry unavailable");
  });

  it("offers a Mountain Project top-rope tick without unavailable outcome placeholders", () => {
    const suggestion = suggestions.at(1);
    if (!suggestion) throw new Error("Expected a climbing suggestion fixture");
    render(
      <UnattachedClimbingEntries
        suggestions={[
          {
            ...suggestion,
            climbType: "route",
            gradeSystem: "yds",
            grade: "5.4",
            routeName: "Swiss Cheese",
            sourceLinks: [
              {
                providerId: "mountain-project",
                kind: "route",
                url: "https://www.mountainproject.com/route/105734732/swiss-cheese",
              },
              {
                providerId: "mountain-project",
                kind: "ticks",
                url: "https://www.mountainproject.com/user/110186720/ticks/ticks",
              },
            ],
            sent: null,
            attemptCount: null,
            lead: false,
            context: {
              ...suggestion.context,
              climbStyle: "top-rope",
              resultStyle: null,
            },
          },
        ]}
        error={null}
        isLoading={false}
        state={{}}
        onAttach={vi.fn()}
      />,
    );
    expect(screen.getByText("Swiss Cheese")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Swiss Cheese on Mountain Project" }).getAttribute("href"),
    ).toBe("https://www.mountainproject.com/route/105734732/swiss-cheese");
    expect(screen.getByRole("link", { name: "Mountain Project ticks" }).getAttribute("href")).toBe(
      "https://www.mountainproject.com/user/110186720/ticks/ticks",
    );
    expect(screen.getByText("5.4", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Top rope")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mountain Project ticks" }).textContent).toBe(
      "Mountain Project",
    );
    expect(screen.getByRole("button", { name: "Attach to this activity" })).toBeInTheDocument();
    expect(screen.queryByText("Result unknown")).not.toBeInTheDocument();
    expect(screen.queryByText(/outcome|attempt/i)).not.toBeInTheDocument();
  });

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
    expect(screen.getByText(/5\.10a · Not sent/)).toBeInTheDocument();
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
      "no data while fetching is paused",
      { suggestions: undefined, error: null, isLoading: false },
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
