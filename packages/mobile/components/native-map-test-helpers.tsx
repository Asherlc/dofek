import {
  createElement,
  forwardRef,
  type ReactNode,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { vi } from "vitest";

export const nativeSnapshot = vi.fn<
  (options: import("@maplibre/maplibre-react-native").StaticMapCreateOptions) => Promise<string>
>(() => Promise.resolve("data:image/png;base64,preview"));

export const nativeCamera = { easeTo: vi.fn(), fitBounds: vi.fn() };

function MockNativeMap({
  children,
  mapStyle,
  style,
  dragPan,
  touchZoom,
  pointerEvents,
  onDidFinishLoadingMap,
  onDidFailLoadingMap,
  onRegionDidChange,
}: {
  children?: ReactNode;
  mapStyle: unknown;
  style: object;
  dragPan?: boolean;
  touchZoom?: boolean;
  pointerEvents?: string;
  onDidFinishLoadingMap?: () => void;
  onDidFailLoadingMap?: () => void;
  onRegionDidChange?: (event: { nativeEvent: { zoom: number } }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const ready = () => onDidFinishLoadingMap?.();
    const fail = () => onDidFailLoadingMap?.();
    const move = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === "number")
        onRegionDidChange?.({ nativeEvent: { zoom: event.detail } });
    };
    element.addEventListener("mapready", ready);
    element.addEventListener("maperror", fail);
    element.addEventListener("mapmove", move);
    return () => {
      element.removeEventListener("mapready", ready);
      element.removeEventListener("maperror", fail);
      element.removeEventListener("mapmove", move);
    };
  }, [onDidFinishLoadingMap, onDidFailLoadingMap, onRegionDidChange]);
  return createElement(
    "div",
    {
      ref,
      "data-testid": "map",
      "data-map-style": JSON.stringify(mapStyle),
      "data-scroll": String(dragPan),
      "data-zoom": String(touchZoom),
      "data-interactive": String(dragPan && touchZoom),
      "data-pointer-events": pointerEvents,
      style,
    },
    children,
  );
}

export const nativeMapMock = {
  StaticMapImageManager: { createImage: nativeSnapshot },
  Map: MockNativeMap,
  Camera: forwardRef(function Camera(
    { initialViewState, bounds }: { initialViewState: unknown; bounds?: unknown },
    ref,
  ) {
    useImperativeHandle(ref, () => nativeCamera);
    return createElement("div", {
      "data-testid": "camera",
      "data-view": JSON.stringify(initialViewState),
      "data-bounds": JSON.stringify(bounds),
    });
  }),
  Marker: ({
    lngLat,
    accessibilityLabel,
    accessibilityHint,
    children,
    onPress,
  }: {
    lngLat: unknown;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    children?: ReactNode;
    onPress?: () => void;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "marker",
        "data-coordinate": JSON.stringify(lngLat),
        title: accessibilityLabel,
        "aria-description": accessibilityHint,
        "aria-label": accessibilityLabel,
        role: "button",
        onClick: onPress,
      },
      children,
    ),
  GeoJSONSource: ({ children, data }: { children?: ReactNode; data: unknown }) =>
    createElement(
      "div",
      { "data-testid": "polyline", "data-coordinates": JSON.stringify(data) },
      children,
    ),
  Layer: () => null,
};
