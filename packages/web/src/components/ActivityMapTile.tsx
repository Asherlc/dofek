import { providerSourceLabel } from "@dofek/providers/providers";
import type { ClimbingMapLocation } from "@dofek/training/climbing-map";
import type { ActivityLocation } from "dofek-server/types";
import { useState } from "react";
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
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadedTiles, setLoadedTiles] = useState<ReadonlySet<number>>(() => new Set());
  const loading = loadedTiles.size < location.mapPreview.tiles.length;

  return (
    <>
      {loadFailed ? (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center text-xs text-muted"
        >
          Map unavailable
        </div>
      ) : (
        <div
          data-testid="activity-route-viewport"
          className="absolute inset-0 h-full w-full"
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
            data-preview-width={location.mapPreview.width}
            data-preview-height={location.mapPreview.height}
            className="absolute inset-0 brightness-[0.95] contrast-[0.92] saturate-[0.85]"
            style={{
              width: "100%",
              height: "100%",
            }}
          >
            {location.mapPreview.tiles.map((tile, tileIndex) => (
              <img
                key={`${tile.url}-${tile.x}-${tile.y}`}
                data-testid="activity-map-preview-tile"
                src={tile.url}
                alt=""
                className="absolute max-w-none"
                loading="lazy"
                referrerPolicy="origin"
                onError={() => setLoadFailed(true)}
                onLoad={() => setLoadedTiles((current) => new Set([...current, tileIndex]))}
                style={{
                  left: `${(tile.x / location.mapPreview.width) * 100}%`,
                  top: `${(tile.y / location.mapPreview.height) * 100}%`,
                  width: `${(tile.width / location.mapPreview.width) * 100}%`,
                  height: `${(tile.height / location.mapPreview.height) * 100}%`,
                }}
              />
            ))}
            {location.kind === "climbing_source" ? (
              <div
                className="pointer-events-none absolute inset-0 h-full w-full"
                aria-hidden="true"
              >
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
          {location.kind === "climbing_source" ? (
            <span className="absolute bottom-2 left-2 rounded bg-surface-solid/90 px-2 py-1 text-xs text-muted">
              Source locations
            </span>
          ) : null}
        </div>
      )}
      {!loadFailed && loading ? <MapProcessingIndicator compact={compact} /> : null}
    </>
  );
}
