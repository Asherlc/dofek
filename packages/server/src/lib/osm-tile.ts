/**
 * OpenStreetMap static tile URL generator.
 *
 * Web Mercator tile coordinates from lat/lng:
 *   x = floor((lng + 180) / 360 * 2^z)
 *   y = floor((1 - ln(tan(latRad) + sec(latRad)) / π) / 2 * 2^z)
 */

import { z } from "zod";

const OSM_TILE_HOST = "https://tile.openstreetmap.org";
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const DEFAULT_ROUTE_PREVIEW_ZOOM = 19;
const MIN_ROUTE_PREVIEW_ZOOM = 1;
const OSM_TILE_SIZE_PX = 256;
const ROUTE_PREVIEW_WIDTH_PX = 1024;
const ROUTE_PREVIEW_HEIGHT_PX = 576;
const ROUTE_PREVIEW_PADDING_PX = 96;

export interface TileCoord {
  zoom: number;
  tileX: number;
  tileY: number;
}

export interface LatLngPoint {
  lat: number;
  lng: number;
}

const routePathPointSchema = z.object({ x: z.number(), y: z.number() });
const osmTilePreviewTileSchema = z.object({
  url: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const osmTilePreviewSchema = z.object({
  width: z.number(),
  height: z.number(),
  tiles: z.array(osmTilePreviewTileSchema),
  routePath: z.array(routePathPointSchema).nullable(),
});

export type RoutePathPoint = z.infer<typeof routePathPointSchema>;
export type OsmTilePreviewTile = z.infer<typeof osmTilePreviewTileSchema>;
export type OsmTilePreview = z.infer<typeof osmTilePreviewSchema>;

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

function wrapTileX(tileX: number, tilesPerAxis: number): number {
  return ((tileX % tilesPerAxis) + tilesPerAxis) % tilesPerAxis;
}

export function latLngToTile(lat: number, lng: number, zoom: number): TileCoord {
  const tilesPerAxis = 2 ** zoom;
  const maxTileIndex = tilesPerAxis - 1;
  const projectedPoint = projectToTilePoint(lat, lng, zoom);
  const rawTileX = Math.floor(projectedPoint.tileX);
  const rawTileY = Math.floor(projectedPoint.tileY);
  const tileX = Math.min(Math.max(rawTileX, 0), maxTileIndex);
  const tileY = Math.min(Math.max(rawTileY, 0), maxTileIndex);
  return { zoom, tileX, tileY };
}

export function osmTileUrl(lat: number, lng: number, zoom = 13): string {
  const { tileX, tileY, zoom: tileZoom } = latLngToTile(lat, lng, zoom);
  return `${OSM_TILE_HOST}/${tileZoom}/${tileX}/${tileY}.png`;
}

export function osmTilePreview(points: LatLngPoint[]): OsmTilePreview {
  const firstPoint = points[0];
  if (!firstPoint) {
    return {
      width: ROUTE_PREVIEW_WIDTH_PX,
      height: ROUTE_PREVIEW_HEIGHT_PX,
      tiles: [
        {
          url: osmTileUrl(0, 0, 0),
          x: (ROUTE_PREVIEW_WIDTH_PX - OSM_TILE_SIZE_PX) / 2,
          y: (ROUTE_PREVIEW_HEIGHT_PX - OSM_TILE_SIZE_PX) / 2,
          width: OSM_TILE_SIZE_PX,
          height: OSM_TILE_SIZE_PX,
        },
      ],
      routePath: null,
    };
  }

  let selectedZoom = DEFAULT_ROUTE_PREVIEW_ZOOM;
  let selectedProjectedPoints: ProjectedTilePoint[] = [];

  for (let zoom = DEFAULT_ROUTE_PREVIEW_ZOOM; zoom >= MIN_ROUTE_PREVIEW_ZOOM; zoom--) {
    selectedZoom = zoom;
    const projectedPoints = points.map((point) => projectToTilePoint(point.lat, point.lng, zoom));
    selectedProjectedPoints = projectedPoints;
    const minPixelX = Math.min(...projectedPoints.map((point) => point.tileX * OSM_TILE_SIZE_PX));
    const maxPixelX = Math.max(...projectedPoints.map((point) => point.tileX * OSM_TILE_SIZE_PX));
    const minPixelY = Math.min(...projectedPoints.map((point) => point.tileY * OSM_TILE_SIZE_PX));
    const maxPixelY = Math.max(...projectedPoints.map((point) => point.tileY * OSM_TILE_SIZE_PX));
    if (
      maxPixelX - minPixelX <= ROUTE_PREVIEW_WIDTH_PX - ROUTE_PREVIEW_PADDING_PX * 2 &&
      maxPixelY - minPixelY <= ROUTE_PREVIEW_HEIGHT_PX - ROUTE_PREVIEW_PADDING_PX * 2
    ) {
      break;
    }
  }

  const minPixelX = Math.min(
    ...selectedProjectedPoints.map((point) => point.tileX * OSM_TILE_SIZE_PX),
  );
  const maxPixelX = Math.max(
    ...selectedProjectedPoints.map((point) => point.tileX * OSM_TILE_SIZE_PX),
  );
  const minPixelY = Math.min(
    ...selectedProjectedPoints.map((point) => point.tileY * OSM_TILE_SIZE_PX),
  );
  const maxPixelY = Math.max(
    ...selectedProjectedPoints.map((point) => point.tileY * OSM_TILE_SIZE_PX),
  );
  const centerPixelX = (minPixelX + maxPixelX) / 2;
  const centerPixelY = (minPixelY + maxPixelY) / 2;
  const worldSizePx = 2 ** selectedZoom * OSM_TILE_SIZE_PX;
  const maxOriginX = Math.max(0, worldSizePx - ROUTE_PREVIEW_WIDTH_PX);
  const maxOriginY = Math.max(0, worldSizePx - ROUTE_PREVIEW_HEIGHT_PX);
  const originPixelX = clamp(centerPixelX - ROUTE_PREVIEW_WIDTH_PX / 2, 0, maxOriginX);
  const originPixelY = clamp(centerPixelY - ROUTE_PREVIEW_HEIGHT_PX / 2, 0, maxOriginY);
  const minTileX = Math.floor(originPixelX / OSM_TILE_SIZE_PX);
  const maxTileX = Math.floor((originPixelX + ROUTE_PREVIEW_WIDTH_PX - 1) / OSM_TILE_SIZE_PX);
  const minTileY = Math.floor(originPixelY / OSM_TILE_SIZE_PX);
  const maxTileY = Math.floor((originPixelY + ROUTE_PREVIEW_HEIGHT_PX - 1) / OSM_TILE_SIZE_PX);
  const tilesPerAxis = 2 ** selectedZoom;
  const maxTileIndex = tilesPerAxis - 1;
  const tiles: OsmTilePreviewTile[] = [];
  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      const wrappedTileX = wrapTileX(tileX, tilesPerAxis);
      const clampedTileY = clamp(tileY, 0, maxTileIndex);
      tiles.push({
        url: `${OSM_TILE_HOST}/${selectedZoom}/${wrappedTileX}/${clampedTileY}.png`,
        x: roundPathCoordinate(tileX * OSM_TILE_SIZE_PX - originPixelX),
        y: roundPathCoordinate(tileY * OSM_TILE_SIZE_PX - originPixelY),
        width: OSM_TILE_SIZE_PX,
        height: OSM_TILE_SIZE_PX,
      });
    }
  }

  const routePath =
    points.length >= 2
      ? selectedProjectedPoints.map((projectedPoint) => {
          return {
            x: roundPathCoordinate(projectedPoint.tileX * OSM_TILE_SIZE_PX - originPixelX),
            y: roundPathCoordinate(projectedPoint.tileY * OSM_TILE_SIZE_PX - originPixelY),
          };
        })
      : null;

  return {
    width: ROUTE_PREVIEW_WIDTH_PX,
    height: ROUTE_PREVIEW_HEIGHT_PX,
    tiles,
    routePath,
  };
}
