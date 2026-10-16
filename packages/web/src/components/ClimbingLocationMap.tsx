import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingLocationMap as ClimbingLocationMapData } from "@dofek/training/climbing-location-map";
import { useEffect, useRef, useState } from "react";
import { captureException } from "../lib/telemetry.ts";
import { QueryStatePanel } from "./QueryStatePanel.tsx";

const DOT_COLOR = "#2563eb";

export function ClimbingLocationMap({
  data,
  loading = false,
}: {
  data?: ClimbingLocationMapData;
  loading?: boolean;
}) {
  const containerRef = useRef<HTMLElement>(null);
  const mapRef = useRef<ReturnType<typeof import("leaflet")["map"]> | null>(null);
  const fittedBoundsRef = useRef<ClimbingLocationMapData["bounds"]>(null);
  const [mapLoading, setMapLoading] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);
  const [tileWarning, setTileWarning] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selected = data?.nodes.find((node) => node.id === selectedNodeId);
  const empty = !data?.bounds || data.nodes.length === 0;

  useEffect(
    () => () => {
      mapRef.current?.remove();
      mapRef.current = null;
      fittedBoundsRef.current = null;
    },
    [],
  );

  useEffect(() => {
    setSelectedNodeId((current) =>
      data?.nodes.some((node) => node.id === current) ? current : null,
    );
    const container = containerRef.current;
    const bounds = data?.bounds;
    if (!container || !data || !bounds || data.nodes.length === 0) return;

    let cancelled = false;
    let removeDots: (() => void) | undefined;
    setMapError(null);

    import("leaflet")
      .then((L) => {
        if (cancelled) return;
        let map = mapRef.current;
        if (!map) {
          map = L.map(container, { minZoom: 0, maxZoom: 19 });
          mapRef.current = map;
          const activeMap = map;
          const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          });
          let tileErrorReported = false;
          tiles.on("tileerror", () => {
            if (mapRef.current !== activeMap || tileErrorReported) return;
            tileErrorReported = true;
            const error = new Error("Map tiles could not load. Check your connection.");
            captureException(error, { component: "ClimbingLocationMap" });
            setTileWarning("Some map tiles could not load. Check your connection.");
          });
          tiles.addTo(map);
        }
        const activeMap = map;
        activeMap.invalidateSize();
        const fittedBounds = fittedBoundsRef.current;
        if (
          !fittedBounds ||
          fittedBounds.south !== bounds.south ||
          fittedBounds.west !== bounds.west ||
          fittedBounds.north !== bounds.north ||
          fittedBounds.east !== bounds.east
        ) {
          activeMap.fitBounds(
            [
              [bounds.south, bounds.west],
              [bounds.north, bounds.east],
            ],
            { padding: [30, 30], maxZoom: 15, animate: false },
          );
          fittedBoundsRef.current = bounds;
        }

        const dots = L.layerGroup().addTo(activeMap);
        const renderDots = () => {
          dots.clearLayers();
          const zoom = Math.floor(activeMap.getZoom());
          for (const node of data.nodes) {
            if (zoom < node.minZoom || zoom > node.maxZoom) continue;
            const { latitude, longitude } = node.coordinates;
            const clustered = node.expansionZoom !== null;
            const name = node.count === 1 ? node.entries[0]?.label : `${node.count} climbs`;
            const label = `${name ?? "Climb"}. ${clustered ? "Zoom in to explore." : "Show climb details."}`;
            const tooltip = document.createElement("span");
            tooltip.textContent = label;
            Object.assign(tooltip.style, {
              display: "block",
              width: "max-content",
              maxWidth: "240px",
              whiteSpace: "normal",
              overflowWrap: "anywhere",
            });
            const dot = L.circleMarker([latitude, longitude], {
              radius: node.radius,
              color: DOT_COLOR,
              fillColor: DOT_COLOR,
              fillOpacity: 0.8,
              weight: 2,
            })
              .bindTooltip(tooltip)
              .addTo(dots);
            dot.on("click", () => {
              if (node.expansionZoom !== null) {
                setSelectedNodeId(null);
                activeMap.setView([latitude, longitude], node.expansionZoom, { animate: false });
              } else {
                setSelectedNodeId(node.id);
              }
            });
            const element = dot.getElement();
            element?.setAttribute("role", "button");
            element?.setAttribute("tabindex", "0");
            element?.setAttribute("aria-label", label);
            element?.addEventListener("focus", () => dot.openTooltip());
            element?.addEventListener("blur", () => dot.closeTooltip());
            element?.addEventListener("keydown", (event) => {
              if (!(event instanceof KeyboardEvent)) return;
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              dot.fire("click");
            });
          }
        };
        removeDots = () => {
          activeMap.off("zoomend", renderDots);
          dots.remove();
        };
        renderDots();
        activeMap.on("zoomend", renderDots);
        setMapLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        captureException(error, { component: "ClimbingLocationMap" });
        setMapError(error instanceof Error ? error.message : String(error));
        setMapLoading(false);
      });

    return () => {
      cancelled = true;
      removeDots?.();
    };
  }, [data]);

  return (
    <div>
      <section
        ref={containerRef}
        aria-label="Climbing locations"
        className={`h-[360px] w-full rounded-lg${empty || mapError ? " hidden" : ""}`}
      />
      {loading && !data ? (
        <QueryStatePanel variant="loading" message="Loading climbing locations…" height={360} />
      ) : empty ? (
        <QueryStatePanel
          variant="empty"
          message="No climbing locations match these dates and filters."
        />
      ) : mapError ? (
        <p role="status" className="text-sm text-red-400">
          Map unavailable: {mapError}
        </p>
      ) : mapLoading ? (
        <p role="status" className="text-sm text-muted">
          Loading map…
        </p>
      ) : null}
      {!empty && !mapError && tileWarning ? (
        <p role="status" className="mt-2 text-sm text-muted">
          {tileWarning}
        </p>
      ) : null}
      {!empty && !mapError && selected ? (
        <ul aria-label="Climbs at this location" className="mt-3 space-y-3">
          {selected.entries.map((entry) => (
            <li key={entry.id} className="rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-medium">{entry.label}</span>
                {entry.grade ? <span>{entry.grade}</span> : null}
                <time className="text-muted" dateTime={entry.date}>
                  {entry.date}
                </time>
              </div>
              <p className="mt-1 text-xs text-muted">
                {entry.location.scope === "area" ? "Area location" : "Climb location"}:{" "}
                {entry.location.name ?? entry.location.objectId} ·{" "}
                {providerSourceLabel(entry.location.providerId)}
              </p>
              {entry.activityId ? (
                <a
                  className="mt-2 inline-block text-accent hover:underline"
                  href={`/activity/${entry.activityId}`}
                  aria-label={`View activity for ${entry.label}`}
                >
                  View activity
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
