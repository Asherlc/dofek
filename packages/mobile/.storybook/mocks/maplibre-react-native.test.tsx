import { createMapStyle } from "@dofek/training/map-style";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Camera, Marker, Map as NativeMap, StaticMapImageManager } from "./maplibre-react-native";

const worker = vi.hoisted(() => ({ configuredUrl: "" }));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({
  default: "/test/map-worker.mjs",
}));

const maps = vi.hoisted(() => {
  const instances: {
    options: { container: HTMLElement };
    emit: (name: string, event?: { error: Error }) => void;
    remove: ReturnType<typeof vi.fn>;
    fitBounds: ReturnType<typeof vi.fn>;
    setStyle: ReturnType<typeof vi.fn>;
    workerUrl: string;
  }[] = [];
  return instances;
});
vi.mock("maplibre-gl", () => ({
  setWorkerUrl: (url: string) => {
    worker.configuredUrl = url;
  },
  Map: class MockGLMap {
    options: { container: HTMLElement };
    workerUrl = worker.configuredUrl;
    handlers = new globalThis.Map<string, ((event?: { error: Error }) => void)[]>();
    remove = vi.fn();
    fitBounds = vi.fn();
    setStyle = vi.fn();
    constructor(options: { container: HTMLElement }) {
      this.options = options;
      maps.push(this);
    }
    on(name: string, listener: (event?: { error: Error }) => void) {
      this.handlers.set(name, [...(this.handlers.get(name) ?? []), listener]);
    }
    once(name: string, listener: (event?: { error: Error }) => void) {
      this.on(name, listener);
    }
    off(name: string, listener: (event?: { error: Error }) => void) {
      this.handlers.set(
        name,
        (this.handlers.get(name) ?? []).filter((entry) => entry !== listener),
      );
    }
    emit(name: string, event?: { error: Error }) {
      for (const listener of this.handlers.get(name) ?? []) listener(event);
    }
    getZoom() {
      return 12;
    }
    getCanvas() {
      return { toDataURL: () => "data:image/png;base64,test" };
    }
  },
  Marker: class MockGLMarker {
    element: HTMLElement;
    constructor({ element }: { element: HTMLElement }) {
      this.element = element;
    }
    setLngLat() {
      return this;
    }
    addTo(map: { options: { container: HTMLElement } }) {
      map.options.container.append(this.element);
      return this;
    }
    remove() {
      this.element.remove();
    }
  },
}));

describe("Storybook MapLibre native adapter", () => {
  beforeEach(() => {
    maps.length = 0;
  });
  it("loads one real styled viewport, fits its native camera and releases it on unmount", () => {
    const onReady = vi.fn();
    const style = createMapStyle("light");
    const view = render(
      <NativeMap
        mapStyle={style}
        style={{ width: 320, height: 280 }}
        onDidFinishLoadingMap={onReady}
      >
        <Camera initialViewState={{ bounds: [-123, 36, -121, 38] }} />
      </NativeMap>,
    );
    expect(maps[0]?.workerUrl).toBe("/test/map-worker.mjs");
    expect(onReady).not.toHaveBeenCalled();
    act(() => maps[0]?.emit("load"));
    expect(onReady).toHaveBeenCalledOnce();
    expect(maps[0]?.fitBounds).toHaveBeenCalledWith(
      [
        [-123, 36],
        [-121, 38],
      ],
      { duration: 0 },
    );
    expect(maps[0]?.setStyle).not.toHaveBeenCalled();
    view.unmount();
    expect(maps[0]?.remove).toHaveBeenCalledOnce();
  });
  it("keeps hostile source labels as text and forwards marker selection", () => {
    const onPress = vi.fn();
    const title = '<img src=x onerror="alert(1)">';
    const view = render(
      <NativeMap mapStyle={createMapStyle("light")}>
        <Marker lngLat={[-122, 37]} accessibilityLabel={title} onPress={onPress}>
          <span>Climb</span>
        </Marker>
      </NativeMap>,
    );
    act(() => maps[0]?.emit("load"));
    fireEvent.click(screen.getByLabelText(title));
    expect(onPress).toHaveBeenCalledOnce();
    expect(view.container.querySelector("img")).toBeNull();
  });
  it("renders a static preview with no retained map context", async () => {
    const request = StaticMapImageManager.createImage({
      center: [-122, 37],
      zoom: 12,
      width: 320,
      height: 180,
      mapStyle: createMapStyle("light"),
    });
    expect(maps[0]?.workerUrl).toBe("/test/map-worker.mjs");
    maps[0]?.emit("idle");
    await expect(request).resolves.toBe("data:image/png;base64,test");
    expect(maps[0]?.remove).toHaveBeenCalledOnce();
    expect(document.querySelector('[style*="-10000px"]')).toBeNull();
  });
  it("fits bounds-mode compact previews into the supplied viewport", async () => {
    const request = StaticMapImageManager.createImage({
      bounds: [-123, 36, -121, 38],
      width: 320,
      height: 140,
      mapStyle: createMapStyle("light"),
    });
    expect(maps[0]?.options).toMatchObject({
      bounds: [
        [-123, 36],
        [-121, 38],
      ],
    });
    maps[0]?.emit("idle");
    await expect(request).resolves.toBeTruthy();
  });

  it("rejects failed snapshots and releases the temporary viewport", async () => {
    const error = new Error("Tile fetch failed");
    const request = StaticMapImageManager.createImage({
      center: [-122, 37],
      zoom: 12,
      width: 320,
      height: 180,
      mapStyle: createMapStyle("light"),
    });
    maps[0]?.emit("error", { error });
    await expect(request).rejects.toBe(error);
    expect(maps[0]?.remove).toHaveBeenCalledOnce();
    expect(document.querySelector('[style*="-10000px"]')).toBeNull();
  });
});
