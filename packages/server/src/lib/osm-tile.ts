/**
 * OpenStreetMap static tile URL generator.
 *
 * Web Mercator tile coordinates from lat/lng:
 *   x = floor((lng + 180) / 360 * 2^z)
 *   y = floor((1 - ln(tan(latRad) + sec(latRad)) / π) / 2 * 2^z)
 */

const OSM_TILE_HOST = "https://tile.openstreetmap.org";
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
const DEFAULT_ROUTE_PREVIEW_ZOOM = 13;
const MIN_ROUTE_PREVIEW_ZOOM = 1;

export interface TileCoord {
  zoom: number;
  tileX: number;
  tileY: number;
}

export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface RoutePathPoint {
  x: number;
  y: number;
}

export interface OsmTilePreview {
  tileUrl: string;
  routePath: RoutePathPoint[] | null;
}

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
    return { tileUrl: osmTileUrl(0, 0, 0), routePath: null };
  }

  let selectedZoom = DEFAULT_ROUTE_PREVIEW_ZOOM;
  let selectedTile = latLngToTile(firstPoint.lat, firstPoint.lng, selectedZoom);

  for (let zoom = DEFAULT_ROUTE_PREVIEW_ZOOM; zoom >= MIN_ROUTE_PREVIEW_ZOOM; zoom--) {
    selectedZoom = zoom;
    selectedTile = latLngToTile(firstPoint.lat, firstPoint.lng, zoom);
    const projectedPoints = points.map((point) => projectToTilePoint(point.lat, point.lng, zoom));
    const minTileX = Math.floor(Math.min(...projectedPoints.map((point) => point.tileX)));
    const maxTileX = Math.floor(Math.max(...projectedPoints.map((point) => point.tileX)));
    const minTileY = Math.floor(Math.min(...projectedPoints.map((point) => point.tileY)));
    const maxTileY = Math.floor(Math.max(...projectedPoints.map((point) => point.tileY)));
    if (minTileX === maxTileX && minTileY === maxTileY) {
      selectedTile = { zoom, tileX: minTileX, tileY: minTileY };
      break;
    }
  }

  const routePath =
    points.length >= 2
      ? points.map((point) => {
          const projectedPoint = projectToTilePoint(point.lat, point.lng, selectedZoom);
          return {
            x: roundPathCoordinate((projectedPoint.tileX - selectedTile.tileX) * 100),
            y: roundPathCoordinate((projectedPoint.tileY - selectedTile.tileY) * 100),
          };
        })
      : null;

  return {
    tileUrl: `${OSM_TILE_HOST}/${selectedZoom}/${selectedTile.tileX}/${selectedTile.tileY}.png`,
    routePath,
  };
}
