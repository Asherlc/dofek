import { vi } from "vitest";

export const maps: TestMap[] = [];
export const markers: TestMarker[] = [];

export class TestMap {
  container: HTMLElement;
  events = new Map<string, Set<(event: unknown) => void>>();
  zoom = 5;
  sources = new Map<string, unknown>();
  constructor(public options: Record<string, unknown>) {
    if (!(options.container instanceof HTMLElement)) throw new Error("Expected map container");
    this.container = options.container;
    this.container.classList.add("maplibregl-map");
    maps.push(this);
  }
  on = vi.fn((event: string, listener: (event: unknown) => void) => {
    const listeners = this.events.get(event) ?? new Set();
    listeners.add(listener);
    this.events.set(event, listeners);
    return this;
  });
  once = vi.fn((event: string, listener: (event: unknown) => void) => {
    const callback = (value: unknown) => {
      this.off(event, callback);
      listener(value);
    };
    return this.on(event, callback);
  });
  off = vi.fn((event: string, listener: (event: unknown) => void) => {
    this.events.get(event)?.delete(listener);
    return this;
  });
  fire(event: string, value: unknown = {}) {
    for (const listener of [...(this.events.get(event) ?? [])]) listener(value);
  }
  fitBounds = vi.fn((bounds: number[][]) => {
    if (bounds.flat().some((value) => !Number.isFinite(value))) throw new Error("Invalid LngLat");
    this.zoom = 5;
  });
  resize = vi.fn();
  easeTo = vi.fn();
  remove = vi.fn(() => this.container.replaceChildren());
  addControl = vi.fn();
  getZoom = () => this.zoom;
  jumpTo = vi.fn((camera: { zoom: number }) => {
    this.zoom = camera.zoom;
    this.fire("zoomend");
  });
  setStyle = vi.fn(() => this.sources.clear());
  addSource = vi.fn((id: string, source: unknown) => this.sources.set(id, source));
  getSource = (id: string) => this.sources.get(id);
  addLayer = vi.fn();
  getCanvas = () => ({ toDataURL: () => "data:image/png;base64,map" });
}

export class TestMarker {
  element: HTMLElement;
  map?: TestMap;
  coordinates?: [number, number];
  constructor(options: { element: HTMLElement }) {
    this.element = options.element;
    markers.push(this);
  }
  setLngLat = vi.fn((coordinates: [number, number]) => {
    if (coordinates.some((value) => !Number.isFinite(value))) throw new Error("Invalid LngLat");
    this.coordinates = coordinates;
    return this;
  });
  addTo(map: TestMap) {
    this.map = map;
    map.container.append(this.element);
    return this;
  }
  remove = vi.fn(() => this.element.remove());
}

export class TestPopup {
  element?: HTMLElement;
  setDOMContent(element: HTMLElement) {
    this.element = element;
    this.element.classList.add("maplibregl-popup-content");
    this.element.setAttribute("role", "tooltip");
    return this;
  }
  setLngLat() {
    return this;
  }
  addTo(map: TestMap) {
    if (this.element) map.container.append(this.element);
    return this;
  }
  remove() {
    this.element?.remove();
    return this;
  }
}

export const maplibreMock = {
  Map: TestMap,
  Marker: TestMarker,
  Popup: TestPopup,
  NavigationControl: class {},
  AttributionControl: class {},
  setWorkerUrl: vi.fn(),
};

export function resetMaps() {
  maps.length = 0;
  markers.length = 0;
}
