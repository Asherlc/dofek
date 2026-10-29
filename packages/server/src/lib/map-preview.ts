/** Server-authored camera and projected overlays for MapLibre activity previews. */

import { z } from "zod";

const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const DEFAULT_ROUTE_PREVIEW_ZOOM = 19;

const PROJECTION_TILE_SIZE_PX = 256;
const ROUTE_PREVIEW_WIDTH_PX = 1024;
const ROUTE_PREVIEW_HEIGHT_PX = 576;
const ROUTE_PREVIEW_PADDING_PX = 96;
const MIN_ROUTE_PREVIEW_ZOOM = Math.log2(ROUTE_PREVIEW_HEIGHT_PX / PROJECTION_TILE_SIZE_PX);

export interface LatLngPoint {
  lat: number;
  lng: number;
}

const routePathPointSchema = z.object({ x: z.number(), y: z.number() });
export const mapPreviewSchema = z.object({
  width: z.number(),
  height: z.number(),
  center: z.tuple([z.number(), z.number()]),
  zoom: z.number(),
  routePath: z.array(routePathPointSchema).nullable(),
});

export type MapPreview = z.infer<typeof mapPreviewSchema>;

interface ProjectedTilePoint {
  tileX: number;
  tileY: number;
}

function normalizeLatitude(lat: number): number {
  return Math.min(Math.max(lat, -WEB_MERCATOR_MAX_LATITUDE), WEB_MERCATOR_MAX_LATITUDE);
}

function normalizeLongitude(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function projectToTilePoint(lat: number, lng: number, zoom: number): ProjectedTilePoint {
  const tilesPerAxis = 2 ** zoom;
  const normalizedLatitude = normalizeLatitude(lat);
  const normalizedLongitude = normalizeLongitude(lng);
  const latRad = (normalizedLatitude * Math.PI) / 180;
  return {
    tileX: ((normalizedLongitude + 180) / 360) * tilesPerAxis,
    tileY: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * tilesPerAxis,
  };
}

function roundPathCoordinate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function routeMapPreview(points: LatLngPoint[]): MapPreview {
  return projectMapPreview(points).preview;
}

export function pointMapPreview<T extends LatLngPoint>(
  points: T[],
): {
  preview: MapPreview & { routePath: null };
  points: { x: number; y: number; point: T }[];
} {
  const projected = projectMapPreview(points, 14);
  return { ...projected, preview: { ...projected.preview, routePath: null } };
}

function projectMapPreview<T extends LatLngPoint>(
  points: T[],
  maximumZoom = DEFAULT_ROUTE_PREVIEW_ZOOM,
): {
  preview: MapPreview;
  points: { x: number; y: number; point: T }[];
} {
  const firstPoint = points[0];
  if (!firstPoint) {
    return {
      points: [],
      preview: {
        width: ROUTE_PREVIEW_WIDTH_PX,
        height: ROUTE_PREVIEW_HEIGHT_PX,
        center: [0, 0],
        zoom: 0,
        routePath: null,
      },
    };
  }

  let selectedZoom = maximumZoom;
  let selectedProjectedPoints: (ProjectedTilePoint & { point: T })[] = [];

  for (let zoom = maximumZoom; ; zoom = Math.max(MIN_ROUTE_PREVIEW_ZOOM, zoom - 1)) {
    selectedZoom = zoom;
    const projectedPoints = points.map((point) => ({
      ...projectToTilePoint(point.lat, point.lng, zoom),
      point,
    }));
    selectedProjectedPoints = projectedPoints;
    const minPixelX = Math.min(
      ...projectedPoints.map((point) => point.tileX * PROJECTION_TILE_SIZE_PX),
    );
    const maxPixelX = Math.max(
      ...projectedPoints.map((point) => point.tileX * PROJECTION_TILE_SIZE_PX),
    );
    const minPixelY = Math.min(
      ...projectedPoints.map((point) => point.tileY * PROJECTION_TILE_SIZE_PX),
    );
    const maxPixelY = Math.max(
      ...projectedPoints.map((point) => point.tileY * PROJECTION_TILE_SIZE_PX),
    );
    if (
      (maxPixelX - minPixelX <= ROUTE_PREVIEW_WIDTH_PX - ROUTE_PREVIEW_PADDING_PX * 2 &&
        maxPixelY - minPixelY <= ROUTE_PREVIEW_HEIGHT_PX - ROUTE_PREVIEW_PADDING_PX * 2) ||
      zoom === MIN_ROUTE_PREVIEW_ZOOM
    ) {
      break;
    }
  }

  const minPixelX = Math.min(
    ...selectedProjectedPoints.map((point) => point.tileX * PROJECTION_TILE_SIZE_PX),
  );
  const maxPixelX = Math.max(
    ...selectedProjectedPoints.map((point) => point.tileX * PROJECTION_TILE_SIZE_PX),
  );
  const minPixelY = Math.min(
    ...selectedProjectedPoints.map((point) => point.tileY * PROJECTION_TILE_SIZE_PX),
  );
  const maxPixelY = Math.max(
    ...selectedProjectedPoints.map((point) => point.tileY * PROJECTION_TILE_SIZE_PX),
  );
  const centerPixelX = (minPixelX + maxPixelX) / 2;
  const centerPixelY = (minPixelY + maxPixelY) / 2;
  const worldSizePx = 2 ** selectedZoom * PROJECTION_TILE_SIZE_PX;
  const maxOriginX = Math.max(0, worldSizePx - ROUTE_PREVIEW_WIDTH_PX);
  const maxOriginY = Math.max(0, worldSizePx - ROUTE_PREVIEW_HEIGHT_PX);
  const originPixelX = clamp(centerPixelX - ROUTE_PREVIEW_WIDTH_PX / 2, 0, maxOriginX);
  const originPixelY = clamp(centerPixelY - ROUTE_PREVIEW_HEIGHT_PX / 2, 0, maxOriginY);
  const viewportCenterX = originPixelX + ROUTE_PREVIEW_WIDTH_PX / 2;
  const viewportCenterY = originPixelY + ROUTE_PREVIEW_HEIGHT_PX / 2;
  const centerLongitude = (viewportCenterX / worldSizePx) * 360 - 180;
  const centerLatitude =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * viewportCenterY) / worldSizePx))) * 180) / Math.PI;

  const projectedPoints = selectedProjectedPoints.map((projectedPoint) => {
    return {
      x: roundPathCoordinate(projectedPoint.tileX * PROJECTION_TILE_SIZE_PX - originPixelX),
      y: roundPathCoordinate(projectedPoint.tileY * PROJECTION_TILE_SIZE_PX - originPixelY),
      point: projectedPoint.point,
    };
  });

  return {
    points: projectedPoints,
    preview: {
      width: ROUTE_PREVIEW_WIDTH_PX,
      height: ROUTE_PREVIEW_HEIGHT_PX,
      center: [centerLongitude, centerLatitude],
      zoom: selectedZoom - 1,
      routePath: points.length >= 2 ? projectedPoints.map(({ x, y }) => ({ x, y })) : null,
    },
  };
}
