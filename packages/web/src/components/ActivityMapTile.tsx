import { useState } from "react";

export type RoutePathPoint = { x: number; y: number };

export interface ActivityMapPreviewTile {
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ActivityMapPreview {
  width: number;
  height: number;
  tiles: ActivityMapPreviewTile[];
  routePath: RoutePathPoint[] | null;
}

export interface ActivityMapLocation {
  mapPreview: ActivityMapPreview;
}

interface ActivityMapTileProps {
  location: ActivityMapLocation;
  variant?: "card" | "panel";
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
  const [loadFailed, setLoadFailed] = useState(false);
  const isPanel = variant === "panel";

  return (
    <div
      data-testid="activity-map-tile"
      className={[
        "relative w-full overflow-hidden bg-surface-secondary",
        isPanel ? "h-full min-h-48" : "aspect-[16/9]",
      ].join(" ")}
    >
      {loadFailed ? (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted">
          Map unavailable
        </div>
      ) : (
        <div
          data-testid="activity-route-viewport"
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label="Activity location map"
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
            {location.mapPreview.tiles.map((tile) => (
              <img
                key={`${tile.url}-${tile.x}-${tile.y}`}
                data-testid="activity-map-preview-tile"
                src={tile.url}
                alt=""
                className="absolute max-w-none"
                loading="lazy"
                referrerPolicy="origin"
                onError={() => setLoadFailed(true)}
                style={{
                  left: `${(tile.x / location.mapPreview.width) * 100}%`,
                  top: `${(tile.y / location.mapPreview.height) * 100}%`,
                  width: `${(tile.width / location.mapPreview.width) * 100}%`,
                  height: `${(tile.height / location.mapPreview.height) * 100}%`,
                }}
              />
            ))}
            <ActivityRouteOverlay mapPreview={location.mapPreview} />
          </div>
        </div>
      )}
    </div>
  );
}
