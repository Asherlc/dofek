/** @vitest-environment jsdom */
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trpc } from "../lib/trpc.ts";
import { ClimbingLocationMap } from "./ClimbingLocationMap.tsx";
import {
  climbingLocationEntries,
  climbingLocationMapFixture,
} from "./climbing-location-map-test-helpers.ts";
import { createClimbingAttachmentFixture } from "./climbing-log-attachment-test-helpers.ts";

const captureException = vi.hoisted(() => vi.fn());
vi.mock("../lib/telemetry.ts", () => ({ captureException }));
beforeEach(() => captureException.mockClear());

vi.mock("maplibre-gl", async () => (await import("../lib/maplibre-test-helpers.ts")).maplibreMock);

import { maps, resetMaps } from "../lib/maplibre-test-helpers.ts";

beforeEach(() => resetMaps());
describe("ClimbingLocationMap", () => {
  it("attaches the selected unattached log and preserves its location while the map refreshes", async () => {
    const fixture = createClimbingAttachmentFixture();
    function ConnectedMap() {
      const map = trpc.climbing.locationMap.useQuery({ days: 90 });
      return <ClimbingLocationMap data={map.data} loading={map.isLoading} />;
    }
    const { container } = render(
      <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
        <QueryClientProvider client={fixture.queryClient}>
          <ConnectedMap />
        </QueryClientProvider>
      </trpc.Provider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." }));
    fireEvent.click(await screen.findByRole("button", { name: "2 climbs. Show climb details." }));
    const pane = container.querySelector(".maplibregl-map");
    const list = screen.getByRole("list", { name: "Climbs at this location" });
    const attachButton = within(list).getByRole("button", {
      name: "Attach to activity for Left Arete",
    });
    attachButton.focus();
    fireEvent.click(attachButton);
    const dialog = await screen.findByRole("dialog", { name: "Attach Left Arete to activity" });
    expect(within(dialog).getByText("2026-10-05")).toBeVisible();
    fireEvent.click(await within(dialog).findByRole("radio", { name: /Approach hike/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      within(screen.getByRole("list", { name: "Climbs at this location" })).getByRole("link", {
        name: "View activity for Left Arete",
      }),
    ).toHaveAttribute("href", "/activity/22222222-2222-4222-8222-222222222222");
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "View activity for Left Arete" })).toHaveFocus(),
    );
    expect(container.querySelector(".maplibregl-map")).toBe(pane);
    expect(fixture.requests).toContainEqual({
      path: "climbing.attachmentActivities",
      input: { date: "2026-10-05" },
    });
    expect(fixture.requests).toContainEqual({
      path: "climbing.attachClimbingLogEntry",
      input: { climbingLogEntryId: "tick-2", activityId: "22222222-2222-4222-8222-222222222222" },
    });
  });

  it("shows processing until initial tiles load, including across an early data refresh", async () => {
    const view = render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." });
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    view.rerender(<ClimbingLocationMap data={{ ...climbingLocationMapFixture }} loading />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "3 climbs. Zoom in to explore." })).toBeVisible(),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    act(() => maps[0]?.fire("load"));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    const pane = view.container.querySelector(".maplibregl-map");
    view.rerender(<ClimbingLocationMap data={{ ...climbingLocationMapFixture }} loading />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "3 climbs. Zoom in to explore." })).toBeVisible(),
    );
    expect(view.container.querySelector(".maplibregl-map")).toBe(pane);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("expands a server-sized cluster into consistent dots without remounting the map", async () => {
    const { container } = render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    const cluster = await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." });
    const pane = container.querySelector(".maplibregl-map");
    const color = cluster.style.backgroundColor;
    expect(cluster).toHaveStyle({ width: "30px", height: "30px" });
    fireEvent.click(cluster);
    const coincident = await screen.findByRole("button", { name: "2 climbs. Show climb details." });
    const single = screen.getByRole("button", { name: "The Traverse. Show climb details." });
    expect(coincident.style.backgroundColor).toBe(color);
    expect(single.style.backgroundColor).toBe(color);
    expect(single).toHaveStyle({ width: "14px", height: "14px" });
    expect(container.querySelector(".maplibregl-map")).toBe(pane);
    expect(maps[0]?.jumpTo).toHaveBeenCalledWith(expect.objectContaining({ zoom: 15 }));
    expect(maps[0]?.options.style).toMatchObject({ version: 8 });
  });

  it.each(["Enter", " "])(
    "supports %s for cluster expansion and coincident entry details",
    async (key) => {
      render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
      const cluster = await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." });
      expect(cluster).toHaveAttribute("tabindex", "0");
      fireEvent.keyDown(cluster, { key });
      const coincident = await screen.findByRole("button", {
        name: "2 climbs. Show climb details.",
      });
      fireEvent.keyDown(coincident, { key });
      const list = screen.getByRole("list", { name: "Climbs at this location" });
      expect(within(list).getByText("Blue Arete")).toBeVisible();
      expect(within(list).getByText("Left Arete")).toBeVisible();
      expect(within(list).getByText("5.10a")).toBeVisible();
      expect(within(list).getByText("2026-10-05")).toBeVisible();
      expect(within(list).getByText("Area location: Goat Rock · OpenBeta")).toBeVisible();
      expect(
        within(list).getByRole("link", { name: "View activity for Blue Arete" }),
      ).toHaveAttribute("href", "/activity/activity-1");
      expect(within(list).queryByRole("link", { name: "View activity for Left Arete" })).toBeNull();
    },
  );

  it("keeps source text safe in tooltips and opens it for keyboard focus", async () => {
    const entry = climbingLocationEntries[0];
    if (!entry) throw new Error("Expected a fixture entry");
    const label = '<img src=x onerror="alert(1)"> & ridge';
    const { container } = render(
      <ClimbingLocationMap
        data={{
          ...climbingLocationMapFixture,
          nodes: [
            {
              ...climbingLocationMapFixture.nodes[2],
              id: "safe-text",
              coordinates: entry.location.coordinates,
              count: 1,
              radius: 7,
              minZoom: 0,
              maxZoom: 19,
              expansionZoom: null,
              entries: [{ ...entry, label }],
            },
          ],
        }}
      />,
    );
    const dot = await screen.findByRole("button", { name: `${label}. Show climb details.` });
    fireEvent.focus(dot);
    expect(container.querySelector(".maplibregl-popup-content")).toHaveTextContent(label);
    expect(container.querySelector(".maplibregl-popup-content img")).toBeNull();
    fireEvent.blur(dot);
    expect(container.querySelector(".maplibregl-popup-content")).toBeNull();
  });

  it("keeps dots usable when map tiles fail and reports the error once", async () => {
    render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    const cluster = await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." });
    act(() => maps[0]?.fire("error", { error: new Error("offline") }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Some map tiles could not load. Check your connection.",
    );
    act(() => maps[0]?.fire("error", { error: new Error("offline") }));
    expect(captureException).toHaveBeenCalledOnce();
    fireEvent.click(cluster);
    expect(
      await screen.findByRole("button", { name: "2 climbs. Show climb details." }),
    ).toBeVisible();
  });

  it("reports initialization errors and shows an actionable map error", async () => {
    render(
      <ClimbingLocationMap
        data={{
          ...climbingLocationMapFixture,
          bounds: { south: Number.NaN, west: -122, north: 38, east: -121 },
        }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Map unavailable: Invalid LngLat"),
    );
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      component: "ClimbingLocationMap",
    });
  });

  it("shows explicit loading and empty states", () => {
    const view = render(<ClimbingLocationMap loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    view.rerender(<ClimbingLocationMap data={{ bounds: null, nodes: [] }} />);
    expect(screen.getByText("No climbing locations match these dates and filters.")).toBeVisible();
  });

  it("waits for the replacement map when corrected data follows an initialization error", async () => {
    const view = render(
      <ClimbingLocationMap
        data={{ ...climbingLocationMapFixture, bounds: { south: NaN, west: 0, north: 1, east: 1 } }}
      />,
    );
    await screen.findByText(/Map unavailable: Invalid LngLat/);
    view.rerender(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." });
    expect(screen.getByRole("status")).toHaveTextContent("Processing map…");
    act(() => maps[1]?.fire("load"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("retains the rendered map and selection while refreshed data is loading", async () => {
    const view = render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    fireEvent.click(await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." }));
    fireEvent.click(await screen.findByRole("button", { name: "2 climbs. Show climb details." }));
    const pane = view.container.querySelector(".maplibregl-map");
    view.rerender(<ClimbingLocationMap data={climbingLocationMapFixture} loading />);
    expect(view.container.querySelector(".maplibregl-map")).toBe(pane);
    expect(screen.getByRole("list", { name: "Climbs at this location" })).toBeVisible();
    expect(screen.queryByText("Loading climbing locations…")).toBeNull();
    await waitFor(() => expect(screen.getByText("Left Arete")).toBeVisible());
  });

  it("preserves the explored zoom when refreshed entries have unchanged map bounds", async () => {
    const view = render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    fireEvent.click(await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." }));
    await screen.findByRole("button", { name: "The Traverse. Show climb details." });
    view.rerender(
      <ClimbingLocationMap
        data={{
          ...climbingLocationMapFixture,
          bounds: { south: 37.234, west: -122.112, north: 37.236, east: -122.111 },
          nodes: climbingLocationMapFixture.nodes.map((node) => ({
            ...node,
            entries: node.entries.map((entry) =>
              entry.id === "tick-3" ? { ...entry, label: "Updated Traverse" } : entry,
            ),
          })),
        }}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Updated Traverse. Show climb details." }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "2 climbs. Show climb details." })).toBeVisible();
  });

  it("keeps selected location details current when refreshes update entries or add another log", async () => {
    const view = render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    fireEvent.click(await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." }));
    fireEvent.click(await screen.findByRole("button", { name: "2 climbs. Show climb details." }));
    const refreshed = {
      ...climbingLocationMapFixture,
      nodes: climbingLocationMapFixture.nodes.map((node) => ({
        ...node,
        entries: node.entries.map((entry) =>
          entry.id === "tick-1" ? { ...entry, label: "Updated Blue Arete", grade: "5.10b" } : entry,
        ),
      })),
    };
    view.rerender(<ClimbingLocationMap data={refreshed} />);
    const list = await screen.findByRole("list", { name: "Climbs at this location" });
    expect(within(list).getByText("Updated Blue Arete")).toBeVisible();
    expect(within(list).getByText("5.10b")).toBeVisible();
    expect(within(list).queryByText("Blue Arete")).toBeNull();
    const unrelated = refreshed.nodes.find((node) => node.id === "single");
    if (!unrelated) throw new Error("Expected an unrelated location fixture");
    view.rerender(
      <ClimbingLocationMap
        data={{
          ...refreshed,
          nodes: [...refreshed.nodes, { ...unrelated, id: "another-location" }],
        }}
      />,
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "Climbs at this location" })).getByText(
          "Updated Blue Arete",
        ),
      ).toBeVisible(),
    );
  });

  it("clears selected details when a refresh no longer contains that location", async () => {
    const view = render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    fireEvent.click(await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." }));
    fireEvent.click(await screen.findByRole("button", { name: "2 climbs. Show climb details." }));
    expect(screen.getByRole("list", { name: "Climbs at this location" })).toBeVisible();
    view.rerender(
      <ClimbingLocationMap
        data={{
          ...climbingLocationMapFixture,
          nodes: climbingLocationMapFixture.nodes.filter((node) => node.id !== "coincident"),
        }}
      />,
    );
    expect(screen.queryByRole("list", { name: "Climbs at this location" })).toBeNull();
  });

  it("preserves the explored zoom after an empty result is replaced by the same bounds", async () => {
    const view = render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    fireEvent.click(await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." }));
    await screen.findByRole("button", { name: "The Traverse. Show climb details." });
    view.rerender(<ClimbingLocationMap data={{ bounds: null, nodes: [] }} />);
    expect(screen.getByText("No climbing locations match these dates and filters.")).toBeVisible();
    view.rerender(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    expect(
      await screen.findByRole("button", { name: "The Traverse. Show climb details." }),
    ).toBeVisible();
  });

  it("fits changed bounds when filters return locations in a new region", async () => {
    const view = render(<ClimbingLocationMap data={climbingLocationMapFixture} />);
    fireEvent.click(await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." }));
    await screen.findByRole("button", { name: "The Traverse. Show climb details." });
    view.rerender(
      <ClimbingLocationMap
        data={{
          ...climbingLocationMapFixture,
          bounds: { south: 36, west: -123, north: 38, east: -121 },
        }}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "3 climbs. Zoom in to explore." }),
    ).toBeVisible();
  });
});
