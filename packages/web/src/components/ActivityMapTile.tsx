import type { UnitConverter } from "@dofek/format/units";
import { formatMeasurementText } from "@dofek/format/units";
import { useState } from "react";

export type RoutePathPoint = { x: number; y: number };

export interface ActivityMapLocation {
  tileUrl: string;
  routePath?: RoutePathPoint[] | null;
  distanceMeters: number | null;
  elevationGainM: number | null;
}

interface ActivityMapTileProps {
  location: ActivityMapLocation;
  units: UnitConverter;
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

function ActivityRouteOverlay({ routePath }: { routePath?: RoutePathPoint[] | null }) {
  const pathData = smoothedRoutePath(routePath);
  if (pathData == null) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
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
        strokeWidth={4}
        vectorEffect="non-scaling-stroke"
      />
      <path
        data-testid="activity-route-path"
        d={pathData}
        fill="none"
        stroke="rgb(22 163 74)"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function ActivityMapTile({ location, units }: ActivityMapTileProps) {
  const [loadFailed, setLoadFailed] = useState(false);

  return (
    <div className="relative aspect-[16/9] w-full overflow-hidden bg-surface-secondary">
      {loadFailed ? (
        <div className="flex h-full w-full items-center justify-center text-xs text-muted">
          Map unavailable
        </div>
      ) : (
        <div data-testid="activity-route-viewport" className="absolute inset-0 h-full w-full">
          <img
            src={location.tileUrl}
            alt="Activity location map"
            className="h-full w-full object-cover brightness-[0.95] contrast-[0.92] saturate-[0.85]"
            loading="lazy"
            referrerPolicy="origin"
            onError={() => setLoadFailed(true)}
          />
          <ActivityRouteOverlay routePath={location.routePath} />
        </div>
      )}
      <div className="absolute bottom-2 left-2 flex flex-wrap gap-1">
        {location.distanceMeters != null ? (
          <span className="rounded-md bg-neutral-950/70 px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm backdrop-blur-[2px]">
            {formatMeasurementText(units.formatDistance(location.distanceMeters / 1000))}
          </span>
        ) : null}
        {location.elevationGainM != null ? (
          <span className="rounded-md bg-neutral-950/70 px-2 py-0.5 text-[11px] font-semibold text-white shadow-sm backdrop-blur-[2px]">
            ↑ {formatMeasurementText(units.formatElevation(location.elevationGainM))}
          </span>
        ) : null}
      </div>
    </div>
  );
}
