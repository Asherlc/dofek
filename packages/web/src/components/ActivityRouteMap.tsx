import { providerSourceLabel } from "@dofek/providers/providers";
import { statusColors } from "@dofek/scoring/colors";
import { type ClimbingMapMarker, groupClimbingMapMarkers } from "@dofek/training/climbing-map";
import { createMapStyle } from "@dofek/training/map-style";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { loadMapLibre, mapColorMode, mapDot, watchMapTheme } from "../lib/maplibre.ts";
import { captureException } from "../lib/telemetry.ts";
import { MapProcessingIndicator } from "./MapProcessingIndicator.tsx";

const NO_CLIMB_MARKERS: readonly ClimbingMapMarker[] = [];

export function ActivityRouteMap({
  points,
  onRegisterHoverCallback,
  climbMarkers = NO_CLIMB_MARKERS,
  presentation = "detail",
  onSelectEntry,
  selectedEntryId: controlledEntryId,
  highlightedEntryId,
}: {
  selectedEntryId?: string | null;
  highlightedEntryId?: string | null;
  points: Array<{ lat: number; lng: number }>;
  climbMarkers?: readonly ClimbingMapMarker[];
  presentation?: "detail" | "compact";
  onSelectEntry?: (entryId: string) => void;
  onRegisterHoverCallback?: React.MutableRefObject<
    (position: { lat: number; lng: number } | null) => void
  >;
}) {
  const mapRef = useRef<HTMLElement>(null);
  const mapInstanceRef = useRef<MapLibreMap | null>(null);
  const [previewVisible, setPreviewVisible] = useState(presentation === "detail");
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [markerElements, setMarkerElements] = useState<HTMLElement[]>([]);
  const activeEntryId = controlledEntryId === undefined ? selectedEntryId : controlledEntryId;
  const selectRef = useRef(onSelectEntry);
  selectRef.current = onSelectEntry;
  const [tileWarning, setTileWarning] = useState<string | null>(null);

  useEffect(() => {
    if (presentation !== "compact" || !mapRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setPreviewVisible(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: "200px" },
    );
    observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, [presentation]);

  const [mapState, setMapState] = useState<{ loading: boolean; error: string | null }>({
    loading: true,
    error: null,
  });

  useEffect(() => {
    if (presentation === "compact" && !previewVisible) return;
    const container = mapRef.current;
    if (!container) return;

    if (points.length === 0 && climbMarkers.length === 0) return;
    setMapState({ loading: true, error: null });
    setTileWarning(null);

    let cancelled = false;

    const cleanups: (() => void)[] = [];
    loadMapLibre()
      .then((M) => {
        if (cancelled) return;
        const map = new M.Map({
          container,
          style: createMapStyle(mapColorMode()),
          attributionControl: {},
          interactive: presentation === "detail",
        });
        mapInstanceRef.current = map;
        if (presentation === "detail")
          map.addControl(new M.NavigationControl({ showCompass: false }), "top-right");
        cleanups.push(watchMapTheme(map));
        map.once("load", () => {
          if (!cancelled) setMapState({ loading: false, error: null });
        });
        let errorReported = false;
        map.on("error", (event) => {
          if (cancelled || errorReported) return;
          errorReported = true;
          captureException(event.error, { component: "ActivityRouteMap" });
          setTileWarning("Some map tiles could not load. Check your connection.");
          setMapState({ loading: false, error: null });
        });
        const route = points.map((point): [number, number] => [point.lng, point.lat]);
        const drawRoute = () => {
          if (cancelled || route.length < 2 || map.getSource("activity-route")) return;
          map.addSource("activity-route", {
            type: "geojson",
            data: {
              type: "Feature",
              properties: {},
              geometry: { type: "LineString", coordinates: route },
            },
          });
          map.addLayer({
            id: "activity-route",
            type: "line",
            source: "activity-route",
            layout: { "line-cap": "round", "line-join": "round" },
            paint: { "line-color": statusColors.positive, "line-width": 3, "line-opacity": 0.8 },
          });
        };
        map.on("style.load", drawRoute);
        map.on("load", drawRoute);
        const start = route[0];
        const end = route[route.length - 1];
        if (start)
          cleanups.push(mapDot(M, map, start, { radius: 6, color: statusColors.positive }).remove);
        if (end)
          cleanups.push(mapDot(M, map, end, { radius: 6, color: statusColors.danger }).remove);
        const groups = groupClimbingMapMarkers(climbMarkers, providerSourceLabel);
        const elements: HTMLElement[] = [];
        for (const group of groups) {
          const { latitude, longitude } = group.coordinates;
          const select = () => {
            const marker = group.markers[0];
            setSelectedEntryId(marker.entryId);
            selectRef.current?.(marker.entryId);
          };
          const dot = mapDot(M, map, [longitude, latitude], {
            radius: group.markers.length > 1 ? 14 : 7,
            color: group.markers.every((marker) => marker.location.scope === "area")
              ? "#d97706"
              : "#2563eb",
            label: `${group.title} · ${group.description}`,
            count: group.markers.length,
            ...(presentation === "detail" ? { onSelect: select } : {}),
          });
          dot.element.setAttribute(
            "data-entry-ids",
            JSON.stringify(group.markers.map((marker) => marker.entryId)),
          );
          if (group.markers.length === 1)
            dot.element.setAttribute("data-entry-id", group.markers[0].entryId);
          elements.push(dot.element);
          cleanups.push(dot.remove);
        }
        setMarkerElements(elements);
        const coordinates = [
          ...route,
          ...groups.map((group): [number, number] => [
            group.coordinates.longitude,
            group.coordinates.latitude,
          ]),
        ];
        const west = Math.min(...coordinates.map(([lng]) => lng));
        const east = Math.max(...coordinates.map(([lng]) => lng));
        const south = Math.min(...coordinates.map(([, lat]) => lat));
        const north = Math.max(...coordinates.map(([, lat]) => lat));
        map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding: 30, duration: 0, ...(points.length === 0 ? { maxZoom: 14 } : {}) },
        );
        if (onRegisterHoverCallback) {
          let hover: ReturnType<typeof mapDot> | null = null;
          cleanups.push(() => hover?.remove());
          onRegisterHoverCallback.current = (position) => {
            if (!position) {
              hover?.remove();
              hover = null;
              return;
            }
            const coordinates: [number, number] = [position.lng, position.lat];
            if (hover) hover.marker.setLngLat(coordinates);
            else
              hover = mapDot(M, map, coordinates, {
                radius: 7,
                color: statusColors.positive,
                fill: "#ffffff",
              });
          };
        }
        const observer = new ResizeObserver(() => map.resize());
        observer.observe(container);
        cleanups.push(() => observer.disconnect());
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        captureException(error, { component: "ActivityRouteMap" });
        for (const cleanup of cleanups.splice(0)) cleanup();
        mapInstanceRef.current?.remove();
        mapInstanceRef.current = null;
        setMapState({
          loading: false,
          error: error instanceof Error ? error.message : "Map initialization failed",
        });
      });

    return () => {
      cancelled = true;
      if (onRegisterHoverCallback) {
        onRegisterHoverCallback.current = () => {};
      }
      for (const cleanup of cleanups) cleanup();
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [points, climbMarkers, presentation, onRegisterHoverCallback, previewVisible]);

  useEffect(() => {
    if (presentation !== "detail") return;
    for (const element of markerElements) {
      const ids: string[] = JSON.parse(element.getAttribute("data-entry-ids") ?? "[]");
      const selected = activeEntryId != null && ids.includes(activeEntryId);
      const highlighted = highlightedEntryId != null && ids.includes(highlightedEntryId);
      element.setAttribute("aria-pressed", String(selected));
      element.setAttribute("data-highlighted", String(highlighted));
      element.style.boxShadow =
        selected || highlighted ? "0 0 0 4px #ffffff, 0 0 0 7px #15803d" : "0 1px 4px #0004";
    }
  }, [markerElements, activeEntryId, highlightedEntryId, presentation]);

  const empty = points.length === 0 && climbMarkers.length === 0;
  return (
    <div>
      <div className="relative isolate rounded-lg">
        <section
          ref={mapRef}
          aria-label={climbMarkers.length > 0 ? "Climbing locations" : "Recorded activity route"}
          className={`isolate w-full rounded-lg ${presentation === "compact" ? "h-[160px]" : "h-[400px]"}${empty || mapState.error ? " hidden" : ""}`}
        />
        {!empty && !mapState.error && mapState.loading ? <MapProcessingIndicator /> : null}
      </div>
      {empty ? (
        <p className="text-sm text-muted">No GPS locations available.</p>
      ) : mapState.error ? (
        <p role="status" className="text-sm text-red-400">
          Map unavailable: {mapState.error}
        </p>
      ) : null}
      {!empty && !mapState.error && tileWarning && (
        <p role="status" className="text-sm text-muted">
          {tileWarning}
        </p>
      )}
    </div>
  );
}
