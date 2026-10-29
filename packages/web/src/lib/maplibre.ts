import { createMapStyle } from "@dofek/training/map-style";
import type { Map as MapLibreMap, Marker, Popup } from "maplibre-gl";

export async function loadMapLibre() {
  const [maplibre, worker] = await Promise.all([
    import("maplibre-gl").then(
      ({ Map: MapConstructor, Marker, Popup, NavigationControl, setWorkerUrl }) => ({
        Map: MapConstructor,
        Marker,
        Popup,
        NavigationControl,
        setWorkerUrl,
      }),
    ),
    import("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"),
  ]);
  maplibre.setWorkerUrl(worker.default);
  return maplibre;
}

export function mapColorMode(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function watchMapTheme(map: MapLibreMap): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const update = () => map.setStyle(createMapStyle(query.matches ? "dark" : "light"));
  query.addEventListener("change", update);
  return () => query.removeEventListener("change", update);
}

export function mapDot(
  maplibre: Awaited<ReturnType<typeof loadMapLibre>>,
  map: MapLibreMap,
  coordinates: [number, number],
  options: {
    color: string;
    radius: number;
    label?: string;
    count?: number;
    onSelect?: () => void;
    fill?: string;
  },
): { marker: Marker; element: HTMLElement; remove: () => void } {
  const element = document.createElement("span");
  Object.assign(element.style, {
    display: "grid",
    placeItems: "center",
    width: `${options.radius * 2}px`,
    height: `${options.radius * 2}px`,
    borderRadius: "50%",
    border: `2px solid ${options.color}`,
    backgroundColor: options.fill ?? options.color,
    color: "white",
    fontSize: "12px",
    fontWeight: "700",
    boxShadow: "0 1px 4px #0004",
    cursor: options.onSelect ? "pointer" : "inherit",
  });
  if (options.count != null && options.count > 1) element.textContent = String(options.count);
  let popup: Popup | undefined;
  if (options.label) {
    element.setAttribute("role", options.onSelect ? "button" : "img");
    element.setAttribute("tabindex", "0");
    element.setAttribute("aria-label", options.label);
    const text = document.createElement("span");
    text.textContent = options.label;
    Object.assign(text.style, {
      display: "block",
      width: "max-content",
      maxWidth: "240px",
      whiteSpace: "normal",
      overflowWrap: "anywhere",
    });
    popup = new maplibre.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: options.radius + 4,
      maxWidth: "260px",
    })
      .setDOMContent(text)
      .setLngLat(coordinates);
    const show = () => popup?.addTo(map);
    const hide = () => popup?.remove();
    element.addEventListener("mouseenter", show);
    element.addEventListener("focus", show);
    element.addEventListener("mouseleave", hide);
    element.addEventListener("blur", hide);
  } else {
    element.setAttribute("aria-hidden", "true");
  }
  if (options.onSelect) {
    element.addEventListener("click", options.onSelect);
    element.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      options.onSelect?.();
    });
  }
  const marker = new maplibre.Marker({ element }).setLngLat(coordinates).addTo(map);
  return {
    marker,
    element,
    remove: () => {
      popup?.remove();
      marker.remove();
    },
  };
}

// A card becomes an image after rendering; only one preview holds a WebGL context.
const snapshotJobs: Array<() => void> = [];
let snapshotRunning = false;

export function queueMapSnapshot(start: (done: () => void) => () => void): () => void {
  let cancel: (() => void) | undefined;
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    snapshotRunning = false;
    snapshotJobs.shift()?.();
  };
  const job = () => {
    snapshotRunning = true;
    cancel = start(done);
  };
  if (snapshotRunning) snapshotJobs.push(job);
  else job();
  return () => {
    const index = snapshotJobs.indexOf(job);
    if (index >= 0) snapshotJobs.splice(index, 1);
    else if (!finished) {
      cancel?.();
      done();
    }
  };
}
