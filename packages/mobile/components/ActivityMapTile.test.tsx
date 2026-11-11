import { createMapStyle } from "@dofek/training/map-style";
import { StaticMapImageManager } from "@maplibre/maplibre-react-native";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActivityLocation } from "dofek-server/types";
import { useColorScheme } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/telemetry";
import { ActivityMapTile } from "./ActivityMapTile";

vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));
const location = {
  kind: "recorded_gps",
  centroidLat: 37,
  centroidLng: -122,
  mapPreview: {
    width: 1024,
    height: 576,
    center: [-122, 37],
    zoom: 12,
    routePath: [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
    ],
  },
} satisfies ActivityLocation;
function measure(width = 320) {
  fireEvent(
    screen.getByTestId("activity-map-panel"),
    new CustomEvent("layout", { detail: { width, height: (width * 9) / 16 } }),
  );
}

describe("ActivityMapTile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StaticMapImageManager.createImage).mockResolvedValue("file:///preview.png");
    vi.mocked(useColorScheme).mockReturnValue("light");
  });
  it("reserves a full-width panel while geometry is processing", () => {
    render(<ActivityMapTile location={{ kind: "processing" }} />);
    expect(
      screen.getByRole("progressbar", { name: "Processing map" }).parentElement?.style.width,
    ).toBe("100%");
  });
  it("uses a native static image with a camera matching the scaled server overlay", async () => {
    render(<ActivityMapTile location={location} />);
    expect(StaticMapImageManager.createImage).not.toHaveBeenCalled();
    measure();
    expect(StaticMapImageManager.createImage).toHaveBeenCalledWith({
      center: [-122, 37],
      zoom: 12 + Math.log2(320 / 1024),
      width: 320,
      height: 180,
      mapStyle: createMapStyle("light"),
      output: "base64",
      logo: false,
    });
    const image = await screen.findByTestId("activity-map-preview");
    expect(screen.getByRole("progressbar", { name: "Processing map" })).toBeTruthy();
    fireEvent.load(image);
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
    expect(screen.getByLabelText("Activity location map")).toBeTruthy();
    expect(document.querySelector('[testid="activity-route-path"]')?.getAttribute("points")).toBe(
      "100,100 200,200",
    );
    expect(screen.getByText(/OpenFreeMap.*OpenMapTiles.*OpenStreetMap/)).toBeTruthy();
  });
  it("keeps the server camera valid at tiny rendered sizes", async () => {
    render(
      <ActivityMapTile
        location={{ ...location, mapPreview: { ...location.mapPreview, zoom: 0 } }}
      />,
    );
    measure(64);
    await waitFor(() =>
      expect(StaticMapImageManager.createImage).toHaveBeenCalledWith(
        expect.objectContaining({ zoom: 0, width: 1024, height: 576 }),
      ),
    );
  });

  it("retains an equal preview during refresh and reloads when camera or theme changes", async () => {
    const view = render(<ActivityMapTile location={location} />);
    measure();
    fireEvent.load(await screen.findByTestId("activity-map-preview"));
    view.rerender(
      <ActivityMapTile location={{ ...location, mapPreview: { ...location.mapPreview } }} />,
    );
    expect(StaticMapImageManager.createImage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
    vi.mocked(useColorScheme).mockReturnValue("dark");
    view.rerender(<ActivityMapTile location={location} />);
    measure();
    await waitFor(() => expect(StaticMapImageManager.createImage).toHaveBeenCalledTimes(2));
    expect(StaticMapImageManager.createImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ mapStyle: createMapStyle("dark") }),
    );
  });
  it("reports a rejected snapshot and clears processing", async () => {
    const error = new Error("Map style download failed");
    vi.mocked(StaticMapImageManager.createImage).mockRejectedValue(error);
    render(<ActivityMapTile location={location} />);
    measure();
    expect(await screen.findByText("Map unavailable")).toBeTruthy();
    expect(captureException).toHaveBeenCalledWith(error);
    expect(screen.queryByRole("progressbar", { name: "Processing map" })).toBeNull();
  });
  it("reports image decoding failures", async () => {
    render(<ActivityMapTile location={location} />);
    measure();
    fireEvent.error(await screen.findByTestId("activity-map-preview"));
    expect(screen.getByText("Map unavailable")).toBeTruthy();
    expect(captureException).toHaveBeenCalled();
  });
  it("ignores an obsolete snapshot after its preview unmounts", async () => {
    let resolve: ((uri: string) => void) | undefined;
    vi.mocked(StaticMapImageManager.createImage).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(<ActivityMapTile location={location} />);
    measure();
    view.unmount();
    await act(async () => resolve?.("data:image/png;base64,obsolete"));
    expect(screen.queryByTestId("activity-map-preview")).toBeNull();
  });
});
