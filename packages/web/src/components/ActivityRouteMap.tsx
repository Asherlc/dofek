import { providerSourceLabel } from "@dofek/providers/providers";
import { statusColors } from "@dofek/scoring/colors";
import type { ClimbingMapMarker } from "@dofek/training/climbing-map";
import type { GpsCoordinates } from "@dofek/training/gps-coordinates";
import { useEffect, useRef, useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { MapProcessingIndicator } from "./MapProcessingIndicator.tsx";

const NO_CLIMB_MARKERS: readonly ClimbingMapMarker[] = [];

export function ActivityRouteMap({
  points,
  onRegisterHoverCallback,
  climbMarkers = NO_CLIMB_MARKERS,
  presentation = "detail",
  onSelectEntry,
}: {
  points: Array<{ lat: number; lng: number }>;
  climbMarkers?: readonly ClimbingMapMarker[];
  presentation?: "detail" | "compact";
  onSelectEntry?: (entryId: string) => void;
  onRegisterHoverCallback?: React.MutableRefObject<
    (position: { lat: number; lng: number } | null) => void
  >;
}) {
  const mapRef = useRef<HTMLElement>(null);
  const mapInstanceRef = useRef<ReturnType<typeof import("leaflet")["map"]> | null>(null);
  const [previewVisible, setPreviewVisible] = useState(presentation === "detail");
  const [inspectedPoint, setInspectedPoint] = useState<GpsCoordinates | null>(null);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);
  const [tileWarning, setTileWarning] = useState<string | null>(null);

  useEffect(() => {
    if (presentation !== "compact" || previewVisible || !mapRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setPreviewVisible(true);
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );
    observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, [presentation, previewVisible]);

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

    import("leaflet")
      .then((L) => {
        if (cancelled || !container) return;

        // Clean up any existing map instance
        if (mapInstanceRef.current) {
          mapInstanceRef.current.remove();
          mapInstanceRef.current = null;
        }

        const map = L.map(container, {
          zoomControl: presentation === "detail",
          attributionControl: true,
        });
        mapInstanceRef.current = map;

        const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        });
        let tileErrorReported = false;
        tiles.on("tileerror", () => {
          if (cancelled || tileErrorReported) return;
          tileErrorReported = true;
          const error = new Error("Map tiles could not load. Check your connection.");
          captureException(error, { component: "ActivityRouteMap" });
          setTileWarning("Some map tiles could not load. Check your connection.");
          setMapState({ loading: false, error: null });
        });
        tiles.once("load", () => {
          if (!cancelled) setMapState({ loading: false, error: null });
        });
        tiles.addTo(map);

        const latLngs = points.map((p) => L.latLng(p.lat, p.lng));

        if (latLngs.length > 0) {
          L.polyline(latLngs, {
            color: statusColors.positive,
            weight: 3,
            opacity: 0.8,
          }).addTo(map);
        }

        // Sensor endpoints do not represent source climb locations.
        const startLatLng = latLngs[0];
        const endLatLng = latLngs[latLngs.length - 1];
        if (startLatLng) {
          L.circleMarker(startLatLng, {
            radius: 6,
            color: statusColors.positive,
            fillColor: statusColors.positive,
            fillOpacity: 1,
          }).addTo(map);
        }
        if (endLatLng) {
          L.circleMarker(endLatLng, {
            radius: 6,
            color: statusColors.danger,
            fillColor: statusColors.danger,
            fillOpacity: 1,
          }).addTo(map);
        }

        const sourceDots = climbMarkers.map((marker, index) => {
          const { latitude, longitude } = marker.location.coordinates;
          const point = L.latLng(latitude, longitude);
          const owner = marker.location.name ?? marker.location.objectId;
          const scope = marker.location.scope === "area" ? "Area location" : "Climb location";
          const label = `Entry ${marker.entryNumber ?? index + 1} · ${marker.label} · ${scope}: ${owner} · ${providerSourceLabel(marker.location.providerId)}`;
          const tooltip = document.createElement("span");
          tooltip.textContent = label;
          Object.assign(tooltip.style, {
            display: "block",
            maxWidth: "240px",
            whiteSpace: "normal",
            overflowWrap: "anywhere",
          });
          const color = marker.location.scope === "area" ? "#d97706" : "#2563eb";
          const dot = L.circleMarker(point, { radius: 7, color, fillColor: color, fillOpacity: 1 })
            .bindTooltip(tooltip)
            .addTo(map);
          if (presentation === "detail") {
            dot.on("click", () => {
              const overlapping = climbMarkers.some(
                (other) =>
                  other.entryId !== marker.entryId &&
                  other.location.coordinates.latitude === latitude &&
                  other.location.coordinates.longitude === longitude,
              );
              if (overlapping) {
                setInspectedPoint(marker.location.coordinates);
              } else {
                setInspectedPoint(null);
                setSelectedEntryId(marker.entryId);
                onSelectEntry?.(marker.entryId);
              }
            });
          }
          return { point, dot, label, entryId: marker.entryId };
        });
        const bounds = L.latLngBounds([...latLngs, ...sourceDots.map(({ point }) => point)]);
        map.fitBounds(bounds, {
          padding: [30, 30],
          ...(points.length === 0 ? { maxZoom: 15 } : {}),
        });
        for (const { dot, label, entryId } of sourceDots) {
          const element = dot.getElement();
          element?.setAttribute("aria-label", label);
          element?.setAttribute("data-entry-id", entryId);
          element?.setAttribute("role", presentation === "detail" ? "button" : "img");
          element?.setAttribute("tabindex", "0");
          element?.addEventListener("focus", () => dot.openTooltip());
          element?.addEventListener("blur", () => dot.closeTooltip());
          if (presentation === "detail") {
            element?.addEventListener("keydown", (event) => {
              if (!(event instanceof KeyboardEvent)) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              dot.fire("click");
            });
          }
        }

        // Register hover marker callback so charts can update the map without React re-renders
        if (onRegisterHoverCallback) {
          let hoverMarker: ReturnType<typeof L.circleMarker> | null = null;

          onRegisterHoverCallback.current = (position) => {
            if (position) {
              if (hoverMarker) {
                hoverMarker.setLatLng([position.lat, position.lng]);
              } else {
                hoverMarker = L.circleMarker([position.lat, position.lng], {
                  radius: 7,
                  color: statusColors.positive,
                  fillColor: "#ffffff",
                  fillOpacity: 1,
                  weight: 3,
                }).addTo(map);
              }
            } else {
              if (hoverMarker) {
                hoverMarker.remove();
                hoverMarker = null;
              }
            }
          };
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        captureException(error, { component: "ActivityRouteMap" });
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
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [points, climbMarkers, presentation, onRegisterHoverCallback, previewVisible, onSelectEntry]);

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
      {presentation === "detail" && inspectedPoint && (
        <ul aria-label="Climbing entries at this location" className="mt-2 flex flex-wrap gap-2">
          {climbMarkers.map((marker, index) => {
            const { latitude, longitude } = marker.location.coordinates;
            if (latitude !== inspectedPoint.latitude || longitude !== inspectedPoint.longitude)
              return null;
            const selected = selectedEntryId === marker.entryId;
            return (
              <li key={marker.entryId} className="min-w-0">
                <button
                  type="button"
                  className="rounded border border-border px-3 py-2 text-sm text-accent"
                  aria-pressed={selected}
                  onClick={() => {
                    setSelectedEntryId(marker.entryId);
                    onSelectEntry?.(marker.entryId);
                  }}
                >
                  Entry {marker.entryNumber ?? index + 1} · {marker.label}
                </button>
              </li>
            );
          })}
        </ul>
      )}
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
