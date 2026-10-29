import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingLocationMap as ClimbingLocationMapData } from "@dofek/training/climbing-location-map";
import { createMapStyle } from "@dofek/training/map-style";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { loadMapLibre, mapColorMode, mapDot, watchMapTheme } from "../lib/maplibre.ts";
import { captureException } from "../lib/telemetry.ts";
import { ClimbingLogAttachment } from "./ClimbingLogAttachment.tsx";
import { MapProcessingIndicator } from "./MapProcessingIndicator.tsx";
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
  const attachmentEntryElementRef = useRef<HTMLLIElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const themeCleanup = useRef<() => void>(() => {});
  const fittedBoundsRef = useRef<ClimbingLocationMapData["bounds"]>(null);
  const [mapLoading, setMapLoading] = useState(true);
  const [mapError, setMapError] = useState<string | null>(null);
  const [tileWarning, setTileWarning] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [attachmentEntryId, setAttachmentEntryId] = useState<string | null>(null);
  const selected = data?.nodes.find((node) => node.id === selectedNodeId);
  const attachmentEntry = selected?.entries.find((entry) => entry.id === attachmentEntryId);
  const empty = !data?.bounds || data.nodes.length === 0;
  const initialLoading = loading && !data;

  useEffect(
    () => () => {
      themeCleanup.current();
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

    loadMapLibre()
      .then((M) => {
        if (cancelled) return;
        let map = mapRef.current;
        if (!map) {
          setMapLoading(true);
          setTileWarning(null);
          map = new M.Map({
            container,
            style: createMapStyle(mapColorMode()),
            minZoom: 0,
            maxZoom: 18,
            attributionControl: {},
          });
          mapRef.current = map;
          const activeMap = map;
          map.addControl(new M.NavigationControl({ showCompass: false }), "top-right");
          themeCleanup.current = watchMapTheme(map);
          map.once("load", () => {
            if (mapRef.current === activeMap) setMapLoading(false);
          });
          let errorReported = false;
          map.on("error", (event) => {
            if (mapRef.current !== activeMap || errorReported) return;
            errorReported = true;
            captureException(event.error, { component: "ClimbingLocationMap" });
            setTileWarning("Some map tiles could not load. Check your connection.");
            setMapLoading(false);
          });
        }
        const activeMap = map;
        activeMap.resize();
        const fitted = fittedBoundsRef.current;
        if (
          !fitted ||
          fitted.south !== bounds.south ||
          fitted.west !== bounds.west ||
          fitted.north !== bounds.north ||
          fitted.east !== bounds.east
        ) {
          activeMap.fitBounds(
            [
              [bounds.west, bounds.south],
              [bounds.east < bounds.west ? bounds.east + 360 : bounds.east, bounds.north],
            ],
            { padding: 30, maxZoom: 14, duration: 0 },
          );
          fittedBoundsRef.current = bounds;
        }
        let dots: ReturnType<typeof mapDot>[] = [];
        const renderDots = () => {
          for (const dot of dots) dot.remove();
          dots = [];
          // Server bands use the original 256px tile convention; MapLibre uses 512px.
          const zoom = Math.floor(activeMap.getZoom() + 1);
          for (const node of data.nodes) {
            if (zoom < node.minZoom || zoom > node.maxZoom) continue;
            const { latitude, longitude } = node.coordinates;
            const name = node.count === 1 ? node.entries[0]?.label : `${node.count} climbs`;
            const label = `${name ?? "Climb"}. ${node.expansionZoom !== null ? "Zoom in to explore." : "Show climb details."}`;
            dots.push(
              mapDot(M, activeMap, [longitude, latitude], {
                color: DOT_COLOR,
                radius: node.radius,
                label,
                count: node.count,
                onSelect: () => {
                  if (node.expansionZoom !== null) {
                    setSelectedNodeId(null);
                    activeMap.jumpTo({
                      center: [longitude, latitude],
                      zoom: node.expansionZoom - 1,
                    });
                  } else setSelectedNodeId(node.id);
                },
              }),
            );
          }
        };
        const observer = new ResizeObserver(() => activeMap.resize());
        observer.observe(container);
        removeDots = () => {
          activeMap.off("zoomend", renderDots);
          for (const dot of dots) dot.remove();
          observer.disconnect();
        };
        renderDots();
        activeMap.on("zoomend", renderDots);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        captureException(error, { component: "ClimbingLocationMap" });
        removeDots?.();
        themeCleanup.current();
        mapRef.current?.remove();
        mapRef.current = null;
        fittedBoundsRef.current = null;
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
      <div
        className={`relative isolate h-[360px] rounded-lg${!initialLoading && (empty || mapError) ? " hidden" : ""}`}
      >
        <section
          ref={containerRef}
          aria-label="Climbing locations"
          className="h-full w-full rounded-lg"
        />
        {initialLoading || (!empty && !mapError && mapLoading) ? <MapProcessingIndicator /> : null}
      </div>
      {!initialLoading && empty ? (
        <QueryStatePanel
          variant="empty"
          message="No climbing locations match these dates and filters."
        />
      ) : !initialLoading && mapError ? (
        <p role="status" className="text-sm text-red-400">
          Map unavailable: {mapError}
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
            <li
              key={entry.id}
              ref={entry.id === attachmentEntryId ? attachmentEntryElementRef : undefined}
              className="rounded-lg border border-border p-3 text-sm"
            >
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
              ) : (
                <button
                  type="button"
                  className="mt-2 inline-block text-accent hover:underline"
                  aria-label={`Attach to activity for ${entry.label}`}
                  onClick={() => setAttachmentEntryId(entry.id)}
                >
                  Attach to activity
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {attachmentEntry ? (
        <ClimbingLogAttachment
          key={attachmentEntry.id}
          entry={attachmentEntry}
          onClose={() => {
            const entryElement = attachmentEntryElementRef.current;
            setAttachmentEntryId(null);
            requestAnimationFrame(() => {
              entryElement?.querySelector<HTMLAnchorElement>("a")?.focus({ preventScroll: true });
            });
          }}
        />
      ) : null}
    </div>
  );
}
