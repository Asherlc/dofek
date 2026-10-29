// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { UnattachedClimbingLogEntries } from "./UnattachedClimbingLogEntries.tsx";

it("highlights the selected suggestion using the full order across a missing-GPS log", () => {
  const entry = climbingLogEntryFixture({ climb: climbingClimbFixture() });
  const location = {
    coordinates: { latitude: 37.234, longitude: -122.111 },
    scope: "climb" as const,
    objectId: "climb",
    providerId: "openbeta",
    name: "Corner",
  };
  render(
    <UnattachedClimbingLogEntries
      suggestions={[
        entry,
        climbingLogEntryFixture({ id: "indoor", title: "Indoor" }),
        { ...entry, id: "repeat" },
      ]}
      selectedEntryId="repeat"
      locations={{ [entry.id]: location, repeat: location }}
      error={null}
      isLoading={false}
      state={{}}
      onAttach={vi.fn()}
    />,
  );
  const cards = within(
    screen.getByRole("region", { name: "Unattached climbing logs" }),
  ).getAllByRole("listitem");
  expect(cards[2]).toHaveTextContent("Indoor");
  expect(cards[1]).toHaveTextContent("Corner");
  expect(cards[1]).toHaveAttribute("aria-current", "true");
  expect(screen.getAllByRole("region", { name: "Climbing locations" })).toHaveLength(2);
});

afterEach(() => vi.unstubAllGlobals());
vi.mock("../../../lib/maplibre.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/maplibre.ts")>()),
  loadMapLibre: async () => (await import("../../../lib/maplibre-test-helpers.ts")).maplibreMock,
}));

it("loads a canonical suggestion's preview near the viewport and keeps its map during Attach updates", async () => {
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
  const entry = climbingLogEntryFixture({ climb: climbingClimbFixture() });
  const props = {
    suggestions: [entry],
    locations: {
      [entry.id]: {
        coordinates: { latitude: 37.234, longitude: -122.111 },
        scope: "climb" as const,
        objectId: "climb",
        providerId: "openbeta",
        name: "Corner",
      },
    },
    error: null,
    isLoading: false,
    onAttach: vi.fn(),
  };
  const view = render(<UnattachedClimbingLogEntries {...props} state={{}} />);
  await act(async () => {
    await import("../../../lib/maplibre.ts");
  });
  expect(view.container.querySelector(".maplibregl-map")).toBeNull();
  act(() => enterViewport());
  await waitFor(() => expect(view.container.querySelector(".maplibregl-map")).not.toBeNull());
  const tile = view.container.querySelector(".maplibregl-map");
  view.rerender(
    <UnattachedClimbingLogEntries
      {...props}
      state={{ [entry.id]: { pending: true, error: null } }}
    />,
  );
  expect(screen.getByText("Attaching...")).toBeInTheDocument();
  expect(view.container.querySelector(".maplibregl-map")).toBe(tile);
});

it("keeps located repeated suggestions in a shared grid with independent Attach states", () => {
  const first = climbingLogEntryFixture({ climb: climbingClimbFixture() });
  const location = {
    coordinates: { latitude: 37.234, longitude: -122.111 },
    scope: "climb" as const,
    objectId: "climb",
    providerId: "openbeta",
    name: "Corner",
  };
  const onAttach = vi.fn();
  render(
    <UnattachedClimbingLogEntries
      suggestions={[first, { ...first, id: "repeat" }]}
      locations={{ [first.id]: location, repeat: location }}
      error={null}
      isLoading={false}
      state={{ [first.id]: { pending: true, error: "Refresh this log." } }}
      onAttach={onAttach}
    />,
  );
  const grid = screen.getByRole("list", { name: "Wall climbs" });
  const firstCard = grid.children[0];
  const repeatCard = grid.children[1];
  if (!(firstCard instanceof HTMLElement) || !(repeatCard instanceof HTMLElement))
    throw new Error("Expected two cards");
  expect(
    within(firstCard).getByRole("button", { name: "Attach entry 1, Corner to this activity" }),
  ).toBeDisabled();
  expect(within(firstCard).getByRole("alert")).toHaveTextContent("Refresh this log.");
  expect(within(repeatCard).queryByRole("alert")).toBeNull();
  fireEvent.click(
    within(repeatCard).getByRole("button", { name: "Attach entry 2, Corner to this activity" }),
  );
  expect(onAttach).toHaveBeenCalledWith("repeat");
  expect(screen.getAllByRole("region", { name: "Climbing locations" })).toHaveLength(2);
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
  fireEvent.click(screen.getByRole("button", { name: "Attach entry 1, Corner to this activity" }));
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
