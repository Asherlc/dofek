import type { StyleSpecification, Map as WebMap } from "maplibre-gl";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import {
  type CSSProperties,
  createContext,
  forwardRef,
  type ReactNode,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { StyleSheet } from "react-native";

maplibregl.setWorkerUrl(workerUrl);

// Browser implementation of the native API for visual Storybook verification.
const MapContext = createContext<WebMap | null>(null);
const SourceContext = createContext<string | null>(null);
type Bounds = [number, number, number, number];
function boundsPair(bounds: Bounds): [[number, number], [number, number]] {
  return [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[3]],
  ];
}

function BrowserMap({
  children,
  mapStyle,
  style,
  dragPan = true,
  touchZoom = true,
  pointerEvents,
  onDidFinishLoadingMap,
  onDidFailLoadingMap,
  onRegionDidChange,
}: {
  children?: ReactNode;
  mapStyle: StyleSpecification;
  style?: CSSProperties;
  dragPan?: boolean;
  touchZoom?: boolean;
  pointerEvents?: CSSProperties["pointerEvents"];
  onDidFinishLoadingMap?: () => void;
  onDidFailLoadingMap?: () => void;
  onRegionDidChange?: (event: { nativeEvent: { zoom: number } }) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const initialOptions = useRef({ mapStyle, dragPan, touchZoom });
  const appliedStyle = useRef(mapStyle);
  const [map, setMap] = useState<WebMap | null>(null);
  const callbacks = useRef({ onDidFinishLoadingMap, onDidFailLoadingMap, onRegionDidChange });
  callbacks.current = { onDidFinishLoadingMap, onDidFailLoadingMap, onRegionDidChange };
  useEffect(() => {
    if (!container.current) return;
    const instance = new maplibregl.Map({
      container: container.current,
      style: initialOptions.current.mapStyle,
      dragPan: initialOptions.current.dragPan,
      scrollZoom: initialOptions.current.touchZoom,
      doubleClickZoom: initialOptions.current.touchZoom,
      touchZoomRotate: initialOptions.current.touchZoom,
      dragRotate: false,
      pitchWithRotate: false,
      attributionControl: false,
    });
    const loaded = () => {
      setMap(instance);
      callbacks.current.onDidFinishLoadingMap?.();
    };
    const failed = () => callbacks.current.onDidFailLoadingMap?.();
    const moved = () =>
      callbacks.current.onRegionDidChange?.({ nativeEvent: { zoom: instance.getZoom() } });
    instance.on("load", loaded);
    instance.on("error", failed);
    instance.on("moveend", moved);
    return () => {
      instance.remove();
    };
  }, []);
  useEffect(() => {
    if (map && appliedStyle.current !== mapStyle) {
      appliedStyle.current = mapStyle;
      map.setStyle(mapStyle);
    }
  }, [map, mapStyle]);
  return (
    <div style={{ ...StyleSheet.flatten(style), pointerEvents }}>
      <div ref={container} style={{ width: "100%", height: "100%" }} />
      <MapContext.Provider value={map}>{map ? children : null}</MapContext.Provider>
    </div>
  );
}

export { BrowserMap as Map };

type ViewState = { bounds?: Bounds; center?: [number, number]; zoom?: number };
export const Camera = forwardRef(function Camera(
  {
    initialViewState,
    bounds,
    duration = 0,
  }: { initialViewState?: ViewState; bounds?: Bounds; duration?: number },
  ref,
) {
  const map = useContext(MapContext);
  useImperativeHandle(
    ref,
    () => ({
      easeTo: (options: { center: [number, number]; zoom: number; duration: number }) =>
        map?.easeTo(options),
      fitBounds: (nextBounds: Bounds, options: object) =>
        map?.fitBounds(boundsPair(nextBounds), options),
    }),
    [map],
  );
  useEffect(() => {
    if (!map || !initialViewState) return;
    if (initialViewState.bounds)
      map.fitBounds(boundsPair(initialViewState.bounds), { duration: 0 });
    else map.jumpTo(initialViewState);
  }, [map, initialViewState]);
  useEffect(() => {
    if (map && bounds) map.fitBounds(boundsPair(bounds), { duration });
  }, [map, bounds, duration]);
  return null;
});

export function Marker({
  children,
  lngLat,
  accessibilityLabel,
  accessibilityHint,
  onPress,
}: {
  children: ReactNode;
  lngLat: [number, number];
  accessibilityLabel?: string;
  accessibilityHint?: string;
  onPress?: () => void;
}) {
  const map = useContext(MapContext);
  const [element] = useState(() => document.createElement("div"));
  const [lng, lat] = lngLat;
  useEffect(() => {
    if (!map) return;
    const marker = new maplibregl.Marker({ element }).setLngLat([lng, lat]).addTo(map);
    return () => marker.remove();
  }, [map, element, lng, lat]);
  useEffect(() => {
    element.setAttribute("aria-label", accessibilityLabel ?? "Map point");
    element.title = [accessibilityLabel, accessibilityHint].filter(Boolean).join(" · ");
    if (onPress) element.addEventListener("click", onPress);
    return () => {
      if (onPress) element.removeEventListener("click", onPress);
    };
  }, [element, accessibilityLabel, accessibilityHint, onPress]);
  return createPortal(children, element);
}

export function GeoJSONSource({
  id,
  children,
  data,
}: {
  id: string;
  children?: ReactNode;
  data: GeoJSON.GeoJSON;
}) {
  const map = useContext(MapContext);
  useEffect(() => {
    if (!map) return;
    const update = () => {
      const source = map.getSource(id);
      if (!source) map.addSource(id, { type: "geojson", data });
      else if (source instanceof maplibregl.GeoJSONSource) source.setData(data);
    };
    update();
    map.on("style.load", update);
    return () => {
      map.off("style.load", update);
    };
  }, [map, id, data]);
  return <SourceContext.Provider value={id}>{children}</SourceContext.Provider>;
}
export function Layer({
  id,
  type,
  paint,
  layout,
}: {
  id: string;
  type: "line";
  paint: object;
  layout: object;
}) {
  const map = useContext(MapContext);
  const source = useContext(SourceContext);
  useEffect(() => {
    if (!map || !source) return;
    const add = () => {
      if (!map.getLayer(id) && map.getSource(source))
        map.addLayer({ id, type, source, paint, layout });
    };
    add();
    map.on("sourcedata", add);
    return () => {
      map.off("sourcedata", add);
      if (map.getLayer(id)) map.removeLayer(id);
    };
  }, [map, source, id, type, paint, layout]);
  return null;
}

export const StaticMapImageManager = {
  createImage({
    center,
    zoom,
    bounds,
    width,
    height,
    mapStyle,
  }: {
    center?: [number, number];
    zoom?: number;
    bounds?: Bounds;
    width: number;
    height: number;
    mapStyle: StyleSpecification;
  }) {
    return new Promise<string>((resolve, reject) => {
      const element = document.createElement("div");
      Object.assign(element.style, {
        width: `${width}px`,
        height: `${height}px`,
        position: "fixed",
        left: "-10000px",
      });
      document.body.append(element);
      const map = new maplibregl.Map({
        container: element,
        style: mapStyle,
        center,
        zoom,
        bounds: bounds ? boundsPair(bounds) : undefined,
        interactive: false,
        attributionControl: false,
        canvasContextAttributes: { preserveDrawingBuffer: true },
      });
      const cleanup = () => {
        map.remove();
        element.remove();
      };
      map.once("idle", () => {
        const uri = map.getCanvas().toDataURL();
        cleanup();
        resolve(uri);
      });
      map.once("error", (event) => {
        cleanup();
        reject(event.error);
      });
    });
  },
};
