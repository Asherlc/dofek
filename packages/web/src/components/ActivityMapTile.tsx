import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import { createMapStyle, mapAttribution } from "@dofek/training/map-style";
import type { ActivityLocation } from "dofek-server/types";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { loadMapLibre, mapColorMode, queueMapSnapshot } from "../lib/maplibre.ts";
import { captureException } from "../lib/telemetry.ts";
import { MapProcessingIndicator } from "./MapProcessingIndicator.tsx";

export type ActivityMapLocation = ActivityLocation;
type ReadyActivityMapLocation = Exclude<ActivityMapLocation, { kind: "processing" }>;
type ActivityMapPreview = ReadyActivityMapLocation["mapPreview"];
type RoutePathPoint = NonNullable<ActivityMapPreview["routePath"]>[number];

function sourceLocationLabel(location: ClimbingMapLocation): string {
  const scope = location.scope === "area" ? "Area location" : "Climb location";
  return `${scope}${location.name ? `: ${location.name}` : ""} · ${providerSourceLabel(location.providerId)}`;
}

interface ActivityMapTileProps {
  location: ActivityMapLocation;
  variant?: "card" | "panel" | "thumbnail";
}

function formatRouteCoordinate(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function routePathPoint(routePoint: RoutePathPoint): string {
  return `${formatRouteCoordinate(routePoint.x)} ${formatRouteCoordinate(routePoint.y)}`;
}

function reflectedRoutePoint(
  anchorPoint: RoutePathPoint,
  nextPoint: RoutePathPoint,
): RoutePathPoint {
  return {
    x: anchorPoint.x - (nextPoint.x - anchorPoint.x),
    y: anchorPoint.y - (nextPoint.y - anchorPoint.y),
  };
}

function smoothedRoutePath(routePath?: RoutePathPoint[] | null): string | null {
  if (routePath == null || routePath.length < 2) return null;

  const firstPoint = routePath[0];
  if (!firstPoint) return null;

  const commands = [`M ${routePathPoint(firstPoint)}`];

  for (let pointIndex = 0; pointIndex < routePath.length - 1; pointIndex += 1) {
    const currentPoint = routePath[pointIndex];
    const nextPoint = routePath[pointIndex + 1];
    if (!currentPoint || !nextPoint) continue;

    const previousPoint = routePath[pointIndex - 1] ?? reflectedRoutePoint(currentPoint, nextPoint);
    const followingPoint =
      routePath[pointIndex + 2] ?? reflectedRoutePoint(nextPoint, currentPoint);
    const firstControlPoint = {
      x: currentPoint.x + (nextPoint.x - previousPoint.x) / 6,
      y: currentPoint.y + (nextPoint.y - previousPoint.y) / 6,
    };
    const secondControlPoint = {
      x: nextPoint.x - (followingPoint.x - currentPoint.x) / 6,
      y: nextPoint.y - (followingPoint.y - currentPoint.y) / 6,
    };

    commands.push(
      `C ${routePathPoint(firstControlPoint)}, ${routePathPoint(secondControlPoint)}, ${routePathPoint(nextPoint)}`,
    );
  }

  return commands.join(" ");
}

function ActivityRouteOverlay({ mapPreview }: { mapPreview: ActivityMapPreview }) {
  const { routePath } = mapPreview;
  const pathData = smoothedRoutePath(routePath);
  if (pathData == null) return null;

  return (
    <svg
      data-testid="activity-route-overlay"
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${mapPreview.width} ${mapPreview.height}`}
      preserveAspectRatio="none"
    >
      <title>Activity route path</title>
      <path
        data-testid="activity-route-casing"
        d={pathData}
        fill="none"
        stroke="rgba(255, 255, 255, 0.9)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={5}
        vectorEffect="non-scaling-stroke"
      />
      <path
        data-testid="activity-route-path"
        d={pathData}
        fill="none"
        stroke="rgb(22 163 74)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={3}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function ActivityMapTile({ location, variant = "card" }: ActivityMapTileProps) {
  return (
    <div
      data-testid="activity-map-tile"
      className={[
        "relative isolate overflow-hidden bg-surface-secondary",
        variant === "thumbnail" ? "h-12 w-16 rounded" : "w-full",
        variant === "panel" ? "h-full min-h-48" : variant === "card" ? "aspect-[16/9]" : "",
      ].join(" ")}
    >
      {location.kind === "processing" ? (
        <MapProcessingIndicator compact={variant === "thumbnail"} />
      ) : (
        <ReadyActivityMapTile
          key={JSON.stringify(location.mapPreview)}
          location={location}
          compact={variant === "thumbnail"}
        />
      )}
    </div>
  );
}

function ReadyActivityMapTile({
  location,
  compact,
}: {
  location: ReadyActivityMapLocation;
  compact: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const background = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [frame, setFrame] = useState<{ width: number; height: number; scale: number } | null>(null);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [mode, setMode] = useState(mapColorMode);
  const { mapPreview } = location;
  const { width: referenceWidth, height: referenceHeight, zoom } = mapPreview;
  const [longitude, latitude] = mapPreview.center;
  const frameReady = frame !== null;
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "200px" },
    );
    observer.observe(element);
    const resize = () => {
      const scale = Math.min(
        element.clientWidth / referenceWidth,
        element.clientHeight / referenceHeight,
      );
      if (scale <= 0) return;
      setFrame((previous) =>
        previous?.scale === scale
          ? previous
          : { width: referenceWidth * scale, height: referenceHeight * scale, scale },
      );
    };
    resize();
    const sizes = new ResizeObserver(resize);
    sizes.observe(element);
    return () => {
      observer.disconnect();
      sizes.disconnect();
    };
  }, [referenceWidth, referenceHeight]);
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const change = () => {
      setMode(query.matches ? "dark" : "light");
      setSnapshot(null);
    };
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    const element = background.current;
    if (!visible || !frameReady || !element || snapshot) return;
    setLoadFailed(false);
    return queueMapSnapshot((done) => {
      let cancelled = false;
      let map: MapLibreMap | null = null;
      const finish = () => {
        map?.remove();
        map = null;
        done();
      };
      const fail = (error: unknown) => {
        if (cancelled) return;
        captureException(error, { component: "ActivityMapTile" });
        setLoadFailed(true);
        finish();
      };
      loadMapLibre()
        .then((M) => {
          if (cancelled) return;
          map = new M.Map({
            container: element,
            style: createMapStyle(mode),
            center: [longitude, latitude],
            zoom,
            interactive: false,
            attributionControl: false,
            canvasContextAttributes: { preserveDrawingBuffer: true },
          });
          map.once("error", (event) => fail(event.error));
          map.once("idle", () => {
            if (cancelled || !map) return;
            try {
              setSnapshot(map.getCanvas().toDataURL("image/png"));
              finish();
            } catch (error) {
              fail(error);
            }
          });
        })
        .catch(fail);
      return () => {
        cancelled = true;
        map?.remove();
        map = null;
      };
    });
  }, [visible, frameReady, longitude, latitude, zoom, mode, snapshot]);

  return (
    <>
      <div
        ref={viewport}
        data-testid="activity-route-viewport"
        className="pointer-events-none absolute inset-0 h-full w-full"
        role="img"
        aria-label={
          location.kind === "climbing_source"
            ? `Climbing source locations · ${location.sourcePoints.map((point) => sourceLocationLabel(point.location)).join("; ")}`
            : compact
              ? "Activity route map summary"
              : "Activity location map"
        }
      >
        <div
          data-testid="activity-map-preview"
          data-preview-width={referenceWidth}
          data-preview-height={referenceHeight}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ width: frame ? frame.width : "100%", height: frame ? frame.height : "100%" }}
        >
          <div
            ref={background}
            aria-hidden="true"
            className="absolute left-0 top-0"
            style={{
              width: referenceWidth,
              height: referenceHeight,
              transform: `scale(${frame?.scale ?? 1})`,
              transformOrigin: "top left",
            }}
          />
          {snapshot ? (
            <img
              data-testid="activity-map-snapshot"
              src={snapshot}
              alt=""
              className="absolute inset-0 h-full w-full"
            />
          ) : null}
          {location.kind === "climbing_source" ? (
            <div className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
              {location.sourcePoints.map((point) => (
                <svg
                  key={`${point.location.providerId}-${point.location.scope}-${point.location.objectId}`}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  width={16}
                  height={16}
                  viewBox="0 0 16 16"
                  style={{
                    left: `${(point.x / location.mapPreview.width) * 100}%`,
                    top: `${(point.y / location.mapPreview.height) * 100}%`,
                  }}
                >
                  <title>{sourceLocationLabel(point.location)}</title>
                  <circle
                    cx={8}
                    cy={8}
                    r={6}
                    fill={point.location.scope === "area" ? "#d97706" : "#2563eb"}
                    stroke="white"
                    strokeWidth={2}
                  />
                </svg>
              ))}
            </div>
          ) : (
            <ActivityRouteOverlay mapPreview={location.mapPreview} />
          )}
        </div>
      </div>
      <span className="pointer-events-none absolute bottom-0 right-0 bg-white/80 px-1 text-[9px] text-black">
        {mapAttribution.replace(/<[^>]+>/g, "")}
      </span>
      {loadFailed ? (
        <div
          role="status"
          className="absolute inset-x-0 bottom-4 bg-surface-secondary/90 p-1 text-center text-xs text-muted"
        >
          Map unavailable. Check your connection.
        </div>
      ) : !snapshot ? (
        <MapProcessingIndicator compact={compact} />
      ) : null}
    </>
  );
}
